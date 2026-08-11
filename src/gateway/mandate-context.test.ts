import { describe, expect, it } from "vitest";
import { mergeMandateIntoSystemPrompt, renderMandateContext } from "./mandate-context.js";

/**
 * SB664 / MyndLens DECISIONS Addendum 59 — pins on the MA-emit renderer.
 * Captain: "Change MyndClaw so that it wil accept all important fields of the MA
 * Emit, so that the Outcome delivery is Precise and repeatable."
 * "Repeatable" is the load-bearing word: same emit in, same bytes out.
 */
describe("renderMandateContext", () => {
  it("returns null for nothing, so a mandate-less run is byte-identical to before", () => {
    expect(renderMandateContext(undefined)).toBeNull();
    expect(renderMandateContext(null)).toBeNull();
    expect(renderMandateContext({})).toBeNull();
    expect(renderMandateContext("not an object")).toBeNull();
    expect(renderMandateContext([1, 2])).toBeNull();
  });

  it("renders the WHY and the WHAT before the detail", () => {
    const out = renderMandateContext({
      zzz_trailing: "last",
      dimensions: { ticker: "ABC" },
      primary_purpose: "decide which penny stock to buy",
      mandate_id: "mandate_abc",
      category: "Investing & Markets",
    })!;
    const order = ["mandate_id:", "category:", "primary_purpose:", "dimensions:", "zzz_trailing:"];
    let cursor = -1;
    for (const key of order) {
      const at = out.indexOf(key);
      expect(at, `${key} missing`).toBeGreaterThan(-1);
      expect(at, `${key} out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("carries UNKNOWN keys — a field added upstream must not need a gateway deploy", () => {
    const out = renderMandateContext({
      mandate_id: "m1",
      a_field_invented_after_this_renderer: "must still reach the agent",
    })!;
    expect(out).toContain("a_field_invented_after_this_renderer");
    expect(out).toContain("must still reach the agent");
  });

  it("is DETERMINISTIC — same emit, same bytes (repeatability, and cache hits)", () => {
    const emit = {
      mandate_id: "m1",
      category: "Investing & Markets",
      dimensions: { ticker: "ABC", budget: 1000 },
      uncertainty: { gaps: ["risk_tolerance"] },
    };
    const a = renderMandateContext(emit);
    const b = renderMandateContext({ ...emit });
    expect(a).toBe(b);
    // key insertion order must not move a byte
    const c = renderMandateContext({
      uncertainty: { gaps: ["risk_tolerance"] },
      dimensions: { budget: 1000, ticker: "ABC" },
      category: "Investing & Markets",
      mandate_id: "m1",
    });
    expect(c).toBe(a);
  });

  it("carries values VERBATIM — never truncated, never summarised", () => {
    const long = "x".repeat(5000);
    const out = renderMandateContext({ mandate_id: "m", primary_purpose: long })!;
    expect(out).toContain(long);
  });

  it("drops empties so absence never reads as a positive statement", () => {
    const out = renderMandateContext({
      mandate_id: "m1",
      deliverables: [],
      report_type: "",
      execution_blockers: null,
    })!;
    expect(out).toContain("mandate_id:");
    expect(out).not.toContain("deliverables");
    expect(out).not.toContain("report_type");
    expect(out).not.toContain("execution_blockers");
  });

  it("renders a dimension's SOURCE so spoken values are distinguishable from defaults", () => {
    const out = renderMandateContext({
      mandate_id: "m1",
      dimensions: {
        budget: { value: 1000, source: "transcript" },
        period: { value: "annual", source: "common_sense" },
      },
    })!;
    expect(out).toContain("transcript");
    expect(out).toContain("common_sense");
  });
});

describe("mergeMandateIntoSystemPrompt", () => {
  it("passes the caller's prompt through untouched when there is no mandate", () => {
    expect(mergeMandateIntoSystemPrompt("keep me", undefined)).toBe("keep me");
    expect(mergeMandateIntoSystemPrompt(undefined, undefined)).toBeUndefined();
  });

  it("keeps the caller's text in the top slot and appends the mandate", () => {
    const merged = mergeMandateIntoSystemPrompt("caller first", { mandate_id: "m1" })!;
    expect(merged.indexOf("caller first")).toBe(0);
    expect(merged.indexOf("mandate_id:")).toBeGreaterThan(merged.indexOf("caller first"));
  });

  it("returns the mandate alone when the caller supplied nothing", () => {
    const merged = mergeMandateIntoSystemPrompt(undefined, { mandate_id: "m1" })!;
    expect(merged.startsWith("## THE MANDATE")).toBe(true);
  });
});
