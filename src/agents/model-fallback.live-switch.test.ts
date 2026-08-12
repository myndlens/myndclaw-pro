import { describe, expect, it } from "vitest";
import { LiveSessionModelSwitchError } from "./live-model-switch.js";
import { runWithModelFallback } from "./model-fallback.js";

/**
 * SB665c (myndlens) — a live-session model switch is CONTROL FLOW, not a
 * candidate failure.
 *
 * Live failure, 2026-08-12 (exec_mandate_2b00dd66 si_2/si_3): a timeout
 * failover persisted a session model override (-> cerebras/gpt-oss-120b).
 * The next run's pre-attempt guard (pi-embedded-runner/run.ts) threw
 * LiveSessionModelSwitchError, and runWithModelFallback treated it as a
 * failed candidate and walked its configured chain (flash -> flash-lite) —
 * every attempt threw BEFORE any model was called, because no chain
 * candidate matched the persisted selection. The mandate lane then surfaced
 * "LiveSessionModelSwitchError" as the run terminal, twice, and the mandate
 * failed with zero model calls on both steps.
 *
 * The law: on a switch signal, ADOPT the requested selection as the very
 * next candidate and retry; bound adoption per distinct selection so
 * ping-pong is structurally impossible.
 */
describe("runWithModelFallback live-session model switch", () => {
  it("adopts the requested selection and retries instead of walking the chain", async () => {
    const calls: string[] = [];
    const result = await runWithModelFallback({
      cfg: undefined,
      provider: "gemini",
      model: "google/gemini-2.5-flash",
      fallbacksOverride: ["gemini/google/gemini-2.5-flash-lite"],
      run: async (provider, model) => {
        calls.push(`${provider}/${model}`);
        if (provider !== "cerebras") {
          throw new LiveSessionModelSwitchError({
            provider: "cerebras",
            model: "gpt-oss-120b",
          });
        }
        return "ok";
      },
    });
    expect(result.result).toBe("ok");
    expect(result.provider).toBe("cerebras");
    expect(result.model).toBe("gpt-oss-120b");
    // The switch target ran IMMEDIATELY after the signal — the configured
    // chain (flash-lite) was never walked past the adopted selection.
    expect(calls[0]).toBe("gemini/google/gemini-2.5-flash");
    expect(calls[1]).toBe("cerebras/gpt-oss-120b");
  });

  it("adopts a given selection at most once — repeated signals cannot loop", async () => {
    let callCount = 0;
    await expect(
      runWithModelFallback({
        cfg: undefined,
        provider: "gemini",
        model: "google/gemini-2.5-flash",
        fallbacksOverride: [],
        run: async () => {
          callCount += 1;
          throw new LiveSessionModelSwitchError({
            provider: "cerebras",
            model: "gpt-oss-120b",
          });
        },
      }),
    ).rejects.toThrow();
    // primary + one adopted retry, never more.
    expect(callCount).toBe(2);
  });
});
