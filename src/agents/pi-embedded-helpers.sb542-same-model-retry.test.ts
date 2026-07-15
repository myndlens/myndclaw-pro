import { describe, expect, it } from "vitest";
import {
  decideSameModelRetry,
  isMalformedFunctionCallError,
} from "./pi-embedded-helpers/errors.js";

// SB542 pins — MyndClaw-Pro same-model retry law.
// The two error strings below are VERBATIM from the live failure that
// motivated this law (gateway log, runId=exec_mandate_f3f2d875717d4b4a).

const LIVE_MALFORMED = "Provider finish_reason: malformed_function_call";
const LIVE_RATE_LIMIT = "⚠️ API rate limit reached. Please try again later.";

describe("SB542 isMalformedFunctionCallError", () => {
  it("matches the live malformed_function_call error verbatim", () => {
    expect(isMalformedFunctionCallError(LIVE_MALFORMED)).toBe(true);
  });
  it("matches without the colon variant", () => {
    expect(isMalformedFunctionCallError("finish_reason malformed_function_call")).toBe(true);
  });
  it("does not match ordinary errors", () => {
    expect(isMalformedFunctionCallError(LIVE_RATE_LIMIT)).toBe(false);
    expect(isMalformedFunctionCallError("")).toBe(false);
  });
});

describe("SB542 decideSameModelRetry", () => {
  const base = { aborted: false, retriesUsed: 0, maxRetries: 1 };

  it("retries ONCE on the live malformed_function_call failure (format_failure)", () => {
    const d = decideSameModelRetry({ ...base, errorText: LIVE_MALFORMED, failoverReason: null });
    expect(d).toEqual({ retry: true, reason: "format_failure", delayMs: 2_000 });
  });

  it("retries ONCE on rate_limit (the live 429) with a real backoff", () => {
    const d = decideSameModelRetry({
      ...base,
      errorText: LIVE_RATE_LIMIT,
      failoverReason: "rate_limit",
    });
    expect(d.retry).toBe(true);
    expect(d.reason).toBe("rate_limit");
    expect(d.delayMs).toBeGreaterThanOrEqual(10_000);
  });

  it("retries ONCE on overloaded", () => {
    const d = decideSameModelRetry({
      ...base,
      errorText: "overloaded",
      failoverReason: "overloaded",
    });
    expect(d.retry).toBe(true);
    expect(d.reason).toBe("overloaded");
  });

  // COUNTER-PINS — the law is bounded and honest.
  it("NEVER retries a second time (budget exhausted)", () => {
    const d = decideSameModelRetry({
      ...base,
      retriesUsed: 1,
      errorText: LIVE_MALFORMED,
      failoverReason: "rate_limit",
    });
    expect(d.retry).toBe(false);
  });

  it("NEVER retries an aborted run", () => {
    const d = decideSameModelRetry({
      ...base,
      aborted: true,
      errorText: LIVE_MALFORMED,
      failoverReason: "rate_limit",
    });
    expect(d.retry).toBe(false);
  });

  it("NEVER retries non-transient failures (auth, billing, clean text)", () => {
    for (const reason of ["auth", "auth_permanent", "billing", "timeout", null] as const) {
      const d = decideSameModelRetry({
        ...base,
        errorText: "some other error",
        failoverReason: reason,
      });
      expect(d.retry).toBe(false);
    }
  });
});
