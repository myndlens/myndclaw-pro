import { describe, expect, it } from "vitest";
import { deriveMandateIdFromSessionKey } from "./session-key-utils.js";

// MyndLens SB674 (Addendum 100) — the exec layer binds skill receipts to the
// mandate by deriving the id from the session key CP itself minted
// (execution_id = "exec_" + mandate_id, mandate_dispatch.py:300/473).
describe("deriveMandateIdFromSessionKey", () => {
  it("derives the mandate id from a live-format namespaced key", () => {
    // Byte-for-byte the key observed on the live gateway for mandate_59438f37.
    expect(
      deriveMandateIdFromSessionKey(
        "agent:cat_investing_markets:mandate:exec_mandate_59438f37e6594e72:g:cat_investing_markets",
      ),
    ).toBe("mandate_59438f37e6594e72");
  });

  it("derives from a bare (non-namespaced) mandate key", () => {
    expect(deriveMandateIdFromSessionKey("mandate:exec_mandate_abc123")).toBe("mandate_abc123");
  });

  it("keeps a segment without the exec_ prefix verbatim", () => {
    // Legacy/probe keys carry the raw segment; pass it through unchanged.
    expect(deriveMandateIdFromSessionKey("agent:main:mandate:sb553probe")).toBe("sb553probe");
  });

  it("preserves case — the receipt id must match what CP minted", () => {
    expect(deriveMandateIdFromSessionKey("mandate:exec_Mandate_ABC")).toBe("Mandate_ABC");
  });

  it("returns undefined for non-mandate sessions (nothing must be injected)", () => {
    expect(deriveMandateIdFromSessionKey("agent:main:main")).toBeUndefined();
    expect(deriveMandateIdFromSessionKey("discord:acct:guild-1:channel-2")).toBeUndefined();
    expect(deriveMandateIdFromSessionKey("")).toBeUndefined();
    expect(deriveMandateIdFromSessionKey(undefined)).toBeUndefined();
    expect(deriveMandateIdFromSessionKey(null)).toBeUndefined();
  });

  it("returns undefined for a mandate key with an empty segment", () => {
    expect(deriveMandateIdFromSessionKey("agent:main:mandate:exec_")).toBeUndefined();
  });
});
