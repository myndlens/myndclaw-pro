import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WAMessage } from "@whiskeysockets/baileys";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

/**
 * SB638 — THE WHATSAPP CAPTURE STORE.
 *
 * Every message the socket delivers — inbound AND outbound (fromMe) — is written here,
 * unconditionally, from the ingress tap that runs above the reply gate. Downstream
 * (Signal Memory) reads this store; it never depends on the auto-reply pipeline again.
 *
 * WHY IT EXISTS (Captain's ruling, 2026-07-28): capture used to require the message to pass
 * the auto-reply access gate, so `dmPolicy: "disabled"` — capture the user's world, never
 * answer as them — silently disabled capture. Signal Memory was pushed onto a nightly route
 * that had to take the whole channel DOWN to read messages ("a BAD solution and unviable"),
 * and the frozen health clock re-linked the device ~41x/day until the account was restricted.
 *
 * WHAT THIS IS NOT: `channel_ingress_events` in the legacy state DB is an orphaned queue table
 * from the 6.8 line (queue_name/status/claim_token/attempts — work-dispatch semantics, and its
 * 22 surviving rows are all `pending`). It has no definition anywhere in this fork. This store
 * is authored fresh, as an archive, in its own database file so the runtime's own schema
 * management never collides with it.
 */

const DB_FILE = "wa-ingress.sqlite";
const DEFAULT_RETENTION_DAYS = 90;
/** Prune is O(index) but pointless per-message; amortise it. */
const PRUNE_EVERY_N_WRITES = 500;

export type IngressStore = {
  record: (accountId: string, msg: WAMessage) => void;
  close: () => void;
  /** Test seam. */
  readonly dbPath: string;
};

export type IngressStoreOptions = {
  /** Overrides the state-dir default; tests pass a tmpdir. */
  dbPath?: string;
  retentionDays?: number;
  /** Called with any write failure. Doctrine 1: capture failure is never silent. */
  onError?: (err: unknown) => void;
  /** SB746 F1: said once per @lid chat whose key carries no remoteJidAlt (recorded under the lid, phone-less). */
  onLidUnresolved?: (lid: string) => void;
};

export function resolveIngressDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MYNDLENS_WA_INGRESS_DB?.trim();
  if (override) {
    return override;
  }
  return path.join(resolveStateDir(env), DB_FILE);
}

/** Text of a message, whatever envelope it arrived in. Null when it carries no text. */
/**
 * SB746 F1 (the Captain, 2 Nov 2026: "Canonical id = wa_ + whatsApp number … the whatsApp number is only one" · "Proceed
 * with the data steps 1 thru 5"): THE CHAT KEY IS THE PARTNER'S WHATSAPP NUMBER. WhatsApp keys live chats by a privacy @lid
 * and puts the partner's phone jid on the same key as remoteJidAlt (Baileys 7). This store keyed every such chat by the lid
 * (measured 1 Nov: 6,900 lid rows, 6,832 with the alt unread) — one person under two chat keys, a thread read on one key
 * half empty. Same law as the tenant recorder (dsv2/wa_extract_shared.mjs resolveLiveChatJid): @s.whatsapp.net → itself;
 * @lid + alt phone jid → the alt, device suffix stripped; @lid without an alt → the lid, said once. Pure.
 */
export function resolveChatJid(
  key: { remoteJid?: string | null; remoteJidAlt?: string | null } | null | undefined,
): {
  chatJid: string;
  lid: string;
  resolved: boolean;
} {
  const jid = String(key?.remoteJid ?? "");
  if (!jid.endsWith("@lid")) return { chatJid: jid, lid: "", resolved: true };
  const alt = String(key?.remoteJidAlt ?? "");
  if (alt.endsWith("@s.whatsapp.net"))
    return { chatJid: alt.replace(/:\d+@/, "@"), lid: jid, resolved: true };
  return { chatJid: jid, lid: jid, resolved: false };
}

export function extractText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) {
    return null;
  }
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null
  );
}

/** Coarse media class, for consumers that filter without parsing the payload. */
export function extractMediaType(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) {
    return null;
  }
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  return null;
}

export function openIngressStore(options: IngressStoreOptions = {}): IngressStore {
  const dbPath = options.dbPath ?? resolveIngressDbPath();
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      account_id   TEXT    NOT NULL,
      msg_id       TEXT    NOT NULL,
      chat_jid     TEXT    NOT NULL,
      sender_jid   TEXT,
      from_me      INTEGER NOT NULL,
      push_name    TEXT,
      text         TEXT,
      media_type   TEXT,
      ts           INTEGER NOT NULL,
      received_at  INTEGER NOT NULL,
      payload_json TEXT    NOT NULL,
      PRIMARY KEY (account_id, msg_id)
    );
    CREATE INDEX IF NOT EXISTS wa_messages_chat_ts  ON wa_messages (chat_jid, ts);
    CREATE INDEX IF NOT EXISTS wa_messages_received ON wa_messages (received_at);
  `);

  // The PK makes re-delivery idempotent: WhatsApp replays messages on reconnect, and a
  // duplicate row would become a duplicate signal downstream.
  const insert = db.prepare(`
    INSERT INTO wa_messages
      (account_id, msg_id, chat_jid, sender_jid, from_me, push_name, text, media_type,
       ts, received_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, msg_id) DO NOTHING
  `);
  const prune = db.prepare("DELETE FROM wa_messages WHERE received_at < ?");

  let writes = 0;
  const saidLids = new Set<string>();

  return {
    dbPath,
    record(accountId: string, msg: WAMessage) {
      try {
        const key = msg.key;
        const msgId = key?.id;
        const ident = resolveChatJid(
          key as { remoteJid?: string | null; remoteJidAlt?: string | null },
        );
        const chatJid = ident.chatJid;
        if (!ident.resolved && !saidLids.has(ident.lid)) {
          saidLids.add(ident.lid);
          options.onLidUnresolved?.(ident.lid);
        }
        if (!msgId || !chatJid) {
          return; // no identity, no row — nothing downstream could join on it
        }
        const now = Date.now();
        const tsRaw = msg.messageTimestamp;
        const ts = tsRaw ? Number(tsRaw) * 1000 : now;
        insert.run(
          accountId,
          String(msgId),
          String(chatJid),
          key?.participant ? String(key.participant) : null,
          key?.fromMe ? 1 : 0,
          msg.pushName ?? null,
          extractText(msg),
          extractMediaType(msg),
          ts,
          now,
          JSON.stringify(msg),
        );
        writes += 1;
        if (writes % PRUNE_EVERY_N_WRITES === 0) {
          prune.run(now - retentionDays * 24 * 60 * 60 * 1000);
        }
      } catch (err) {
        // Doctrine 1: Signal Memory depends on this write. A lost message is reported, never
        // swallowed — and never allowed to break the socket that delivered it.
        options.onError?.(err);
      }
    },
    close() {
      db.close();
    },
  };
}
