import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";

/**
 * SB638 — THE INGRESS TAP FIRES ABOVE THE REPLY GATE.
 *
 * Live incident (2026-07-28): this build required a message to be ALLOWED TO BE REPLIED TO
 * before it was captured, before any hook fired, and before the channel health clock ticked.
 * `dmPolicy: "disabled"` — a deliberate posture (capture the user's world, never answer as
 * them) — therefore froze `lastEventAt`, the health monitor read a live socket as dead, and
 * re-linked the device ~41x/day until WhatsApp restricted the account (78 relinks / 73
 * stale-triggered, measured over 48h).
 *
 * The law: capture is unconditional; only REPLY is a policy question. These pins hold the
 * ordering that makes that true — the tap runs for every raw message, inbound and fromMe,
 * before normalisation and before access control, and a tap failure never eats the message.
 */

type UpsertHandler = (u: { type?: string; messages?: WAMessage[] }) => Promise<void>;

/**
 * The shape of handleMessagesUpsert's loop head, mirrored: tap first, then the pipeline
 * (normalise -> access gate -> onMessage). Mirrors monitor.ts:462-478.
 */
function makeUpsertLoop(opts: {
  onIngress?: (msg: WAMessage) => void;
  gateAllows: boolean;
  onMessage: (msg: WAMessage) => Promise<void>;
  onTapError: (err: unknown) => void;
}): UpsertHandler {
  return async (upsert) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      try {
        opts.onIngress?.(msg);
      } catch (err) {
        opts.onTapError(err);
      }
      if (!opts.gateAllows) {
        continue; // inbound/monitor.ts:277 — `if (!access.allowed) return null`
      }
      await opts.onMessage(msg);
    }
  };
}

const msg = (fromMe: boolean, id: string): WAMessage =>
  ({ key: { id, fromMe, remoteJid: "1555@s.whatsapp.net" } }) as unknown as WAMessage;

describe("SB638 ingress tap", () => {
  it("captures and ticks the clock when the reply gate is CLOSED (dmPolicy=disabled)", async () => {
    const tapped: string[] = [];
    const replied: string[] = [];
    const loop = makeUpsertLoop({
      onIngress: (m) => tapped.push(String(m.key?.id)),
      gateAllows: false,
      onMessage: async (m) => {
        replied.push(String(m.key?.id));
      },
      onTapError: () => {},
    });

    await loop({ type: "notify", messages: [msg(false, "a"), msg(false, "b")] });

    expect(tapped).toEqual(["a", "b"]);
    expect(replied).toEqual([]); // the posture is preserved: nothing is answered
  });

  it("captures OUTBOUND (fromMe) messages too", async () => {
    const tapped: string[] = [];
    const loop = makeUpsertLoop({
      onIngress: (m) => tapped.push(`${m.key?.fromMe ? "out" : "in"}:${m.key?.id}`),
      gateAllows: false,
      onMessage: async () => {},
      onTapError: () => {},
    });

    await loop({ type: "notify", messages: [msg(true, "sent"), msg(false, "recv")] });

    expect(tapped).toEqual(["out:sent", "in:recv"]);
  });

  it("still delivers to the reply pipeline when the gate is OPEN", async () => {
    const tapped: string[] = [];
    const replied: string[] = [];
    const loop = makeUpsertLoop({
      onIngress: (m) => tapped.push(String(m.key?.id)),
      gateAllows: true,
      onMessage: async (m) => {
        replied.push(String(m.key?.id));
      },
      onTapError: () => {},
    });

    await loop({ type: "notify", messages: [msg(false, "x")] });

    expect(tapped).toEqual(["x"]);
    expect(replied).toEqual(["x"]); // tap is additive, never a replacement
  });

  it("a throwing tap is reported LOUDLY and never eats the message (Doctrine 1)", async () => {
    const errors: unknown[] = [];
    const replied: string[] = [];
    const loop = makeUpsertLoop({
      onIngress: () => {
        throw new Error("sqlite is down");
      },
      gateAllows: true,
      onMessage: async (m) => {
        replied.push(String(m.key?.id));
      },
      onTapError: (e) => errors.push(e),
    });

    await loop({ type: "notify", messages: [msg(false, "y")] });

    expect(errors).toHaveLength(1);
    expect(replied).toEqual(["y"]);
  });

  it("ignores upsert types that are not notify/append", async () => {
    const tapped: string[] = [];
    const loop = makeUpsertLoop({
      onIngress: (m) => tapped.push(String(m.key?.id)),
      gateAllows: false,
      onMessage: async () => {},
      onTapError: () => {},
    });

    await loop({ type: "prepend", messages: [msg(false, "z")] });

    expect(tapped).toEqual([]);
  });
});
