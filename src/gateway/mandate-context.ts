/**
 * SB664 / MyndLens DECISIONS Addendum 59 — RENDER THE MA EMIT FOR THE AGENT.
 *
 * Captain, 2026-08-11: "Change MyndClaw so that it wil accept all important fields
 * of the MA Emit, so that the Outcome delivery is Precise and repeatable."
 *
 * WHAT THIS IS FOR. Before it, the run-agent contract was five fields, and the
 * mandate-level cognition the upstream pipeline had spent many LLM calls deriving —
 * why the user asked, what they must hold at the end, which dimension values they
 * SPOKE versus which were defaulted, who the resolved people are, what could not be
 * closed — reached the agent nowhere. The agent optimised for the step in front of
 * it because that was all it could see.
 *
 * THE ONE LAW HERE: this renders, it does not decide.
 *   · Values are carried VERBATIM. Nothing is summarised, re-ranked, paraphrased or
 *     truncated. A summary would be the gateway deciding what the agent may know.
 *   · Unknown keys are rendered too. The schema is open on purpose; a renderer that
 *     only knew a fixed list would silently swallow every field added upstream after
 *     it was written — the exact failure mode this whole change exists to end.
 *   · Ordering is DETERMINISTIC (known keys in a fixed, meaningful order, then the
 *     rest alphabetically). Same emit in, same bytes out — that is the "repeatable"
 *     half of the Captain's sentence, and it is also what makes prompt caching work.
 *   · Empty and absent values are dropped rather than rendered as "none", so an
 *     absent field never reads to the model as a positive statement of absence.
 */

/** Rendered first, in this order: the WHY and the WHAT before the detail. */
const PRIORITY_KEYS = [
  "mandate_id",
  "category",
  "primary_purpose",
  "primary_outcome",
  "restated_intent",
  "enhanced_intent",
  "execution_pattern",
  "deliverables",
  "delivery_channels",
  "report_type",
] as const;

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) {
    return true;
  }
  if (typeof v === "string") {
    return v.trim() === "";
  }
  if (Array.isArray(v)) {
    return v.length === 0;
  }
  if (typeof v === "object") {
    return Object.keys(v).length === 0;
  }
  return false;
}

function renderValue(value: unknown, indent: string): string {
  if (typeof value === "string") {
    // Multi-line strings keep their shape; the agent reads prose as prose.
    return value.includes("\n")
      ? "\n" +
          value
            .split("\n")
            .map((l) => `${indent}  ${l}`)
            .join("\n")
      : ` ${value}`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return ` ${String(value)}`;
  }
  if (Array.isArray(value)) {
    const scalars = value.every(
      (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (scalars) {
      return ` ${value.map((v) => String(v)).join(", ")}`;
    }
    return "\n" + value.map((v) => `${indent}  - ${JSON.stringify(v)}`).join("\n");
  }
  if (value && typeof value === "object") {
    // Sorted, NOT insertion-ordered. A nested object arriving with its keys in a
    // different order is the same emit and must render to the same bytes — the pin
    // `is DETERMINISTIC` caught this rendering {ticker, budget} and {budget, ticker}
    // differently, which would have broken repeatability and every prompt-cache hit.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => !isEmpty(v))
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) {
      return "";
    }
    return (
      "\n" + entries.map(([k, v]) => `${indent}  ${k}:${renderValue(v, `${indent}  `)}`).join("\n")
    );
  }
  return "";
}

/**
 * Render the MA emit as a system-prompt block, or null when there is nothing to say.
 * Returning null (never an empty header) keeps a mandate-less run byte-identical to
 * its pre-SB664 self.
 */
export function renderMandateContext(mandate: unknown): string | null {
  if (!mandate || typeof mandate !== "object" || Array.isArray(mandate)) {
    return null;
  }
  const src = mandate as Record<string, unknown>;

  const seen = new Set<string>();
  const ordered: Array<[string, unknown]> = [];
  for (const k of PRIORITY_KEYS) {
    if (k in src && !isEmpty(src[k])) {
      ordered.push([k, src[k]]);
      seen.add(k);
    }
  }
  for (const k of Object.keys(src).toSorted()) {
    if (seen.has(k) || isEmpty(src[k])) {
      continue;
    }
    ordered.push([k, src[k]]);
  }
  if (ordered.length === 0) {
    return null;
  }

  const lines: string[] = [
    "## THE MANDATE (from the MyndLens Control Plane — DECLARED, not inferred)",
    "This is what the pipeline established before you were dispatched. Treat it as",
    "given: do not re-derive it, do not second-guess it, and do not ask the user for",
    "anything already stated here. Where a value is marked as coming from the user,",
    "it is the user's own word and is not yours to override. Where the mandate names",
    "an uncertainty, surface it honestly in your work rather than writing over it.",
    "",
  ];
  for (const [k, v] of ordered) {
    const rendered = renderValue(v, "");
    if (rendered === "") {
      continue;
    }
    lines.push(`${k}:${rendered}`);
  }
  return lines.join("\n");
}
