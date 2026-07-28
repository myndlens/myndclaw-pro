import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WAMessage } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractMediaType, extractText, openIngressStore } from "./ingress-store.js";

/**
 * SB638 — the capture store. Signal Memory reads THIS, so a message that reaches the socket
 * must reach this table regardless of reply posture, and a failure to write must be loud.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-ingress-"));
  dbPath = path.join(dir, "test.sqlite");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const msg = (over: Record<string, unknown> = {}): WAMessage =>
  ({
    key: { id: "M1", remoteJid: "15551234@s.whatsapp.net", fromMe: false },
    messageTimestamp: 1_700_000_000,
    pushName: "Venkat",
    message: { conversation: "hello there" },
    ...over,
  }) as unknown as WAMessage;

const rows = (p: string) => {
  const db = new DatabaseSync(p, { readOnly: true });
  const out = db.prepare("SELECT * FROM wa_messages ORDER BY received_at, msg_id").all();
  db.close();
  return out as Array<Record<string, unknown>>;
};

describe("SB638 capture store", () => {
  it("records an inbound message with its identity, text and payload", () => {
    const store = openIngressStore({ dbPath });
    store.record("acct1", msg());
    store.close();

    const [r] = rows(dbPath);
    expect(r.account_id).toBe("acct1");
    expect(r.msg_id).toBe("M1");
    expect(r.chat_jid).toBe("15551234@s.whatsapp.net");
    expect(r.from_me).toBe(0);
    expect(r.push_name).toBe("Venkat");
    expect(r.text).toBe("hello there");
    expect(r.ts).toBe(1_700_000_000_000); // seconds → ms
    expect(JSON.parse(String(r.payload_json)).key.id).toBe("M1"); // raw fidelity preserved
  });

  it("records OUTBOUND (fromMe) messages — the Captain's 'outbound and inbound'", () => {
    const store = openIngressStore({ dbPath });
    store.record(
      "acct1",
      msg({ key: { id: "OUT", remoteJid: "1555@s.whatsapp.net", fromMe: true } }),
    );
    store.close();

    const [r] = rows(dbPath);
    expect(r.msg_id).toBe("OUT");
    expect(r.from_me).toBe(1);
  });

  it("is idempotent — a replayed message does not become a second signal", () => {
    const store = openIngressStore({ dbPath });
    store.record("acct1", msg());
    store.record("acct1", msg()); // WhatsApp replays on reconnect
    store.close();

    expect(rows(dbPath)).toHaveLength(1);
  });

  it("keeps the same id under different accounts apart", () => {
    const store = openIngressStore({ dbPath });
    store.record("acct1", msg());
    store.record("acct2", msg());
    store.close();

    expect(rows(dbPath)).toHaveLength(2);
  });

  it("captures media messages with their class and caption", () => {
    const store = openIngressStore({ dbPath });
    store.record(
      "acct1",
      msg({
        message: { imageMessage: { caption: "the chart" } },
        key: { id: "IMG", remoteJid: "1555@s.whatsapp.net", fromMe: false },
      }),
    );
    store.close();

    const [r] = rows(dbPath);
    expect(r.media_type).toBe("image");
    expect(r.text).toBe("the chart");
  });

  it("skips a message with no id or chat — nothing downstream could join on it", () => {
    const store = openIngressStore({ dbPath });
    store.record("acct1", msg({ key: { fromMe: false } }));
    store.close();

    expect(rows(dbPath)).toHaveLength(0);
  });

  it("reports write failures LOUDLY and never throws at the caller (Doctrine 1)", () => {
    const errors: unknown[] = [];
    const store = openIngressStore({ dbPath, onError: (e) => errors.push(e) });
    store.close(); // db is gone; the next write must fail

    expect(() => store.record("acct1", msg())).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("extractText / extractMediaType read every envelope we care about", () => {
    expect(extractText(msg({ message: { extendedTextMessage: { text: "quoted" } } }))).toBe(
      "quoted",
    );
    expect(extractText(msg({ message: {} }))).toBeNull();
    expect(extractMediaType(msg({ message: { audioMessage: {} } }))).toBe("audio");
    expect(extractMediaType(msg({ message: { conversation: "x" } }))).toBeNull();
  });
});
