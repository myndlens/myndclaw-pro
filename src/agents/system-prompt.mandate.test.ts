import { describe, expect, it } from "vitest";
import { renderMandateContext } from "../gateway/mandate-context.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

/**
 * SB664 / MyndLens Addendum 59 — the mandate gets its OWN system-prompt section.
 *
 * The first cut merged the mandate into extraSystemPrompt, and
 * buildAgentSystemPrompt wraps that lane in a hardcoded contextHeader —
 * "## Group Chat Context" for full-mode runs. The user's mandate arrived filed
 * as chat chatter. These pins make that regression impossible to reintroduce
 * silently.
 */
describe("buildAgentSystemPrompt mandateContext", () => {
  const mandateBlock = renderMandateContext({
    mandate_id: "mandate_pin1",
    primary_purpose: "decide which penny stock to buy",
  })!;

  it("renders the mandate under its own header, NOT under Group Chat Context", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      mandateContext: mandateBlock,
    });
    expect(prompt).toContain("## THE MANDATE");
    expect(prompt).toContain("mandate_pin1");
    const groupIdx = prompt.indexOf("## Group Chat Context");
    if (groupIdx !== -1) {
      // if a group section exists at all, the mandate must not sit inside it
      expect(prompt.indexOf("mandate_pin1")).toBeLessThan(groupIdx);
    }
  });

  it("keeps the mandate OUT of the Group Chat Context section when extraSystemPrompt is also set", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      mandateContext: mandateBlock,
      extraSystemPrompt: "group chat stuff here",
    });
    const mandateIdx = prompt.indexOf("## THE MANDATE");
    const groupIdx = prompt.indexOf("## Group Chat Context");
    expect(mandateIdx).toBeGreaterThan(-1);
    expect(groupIdx).toBeGreaterThan(-1);
    // the mandate outranks per-message chat context
    expect(mandateIdx).toBeLessThan(groupIdx);
    // and the chat lane still works untouched
    expect(prompt.indexOf("group chat stuff here")).toBeGreaterThan(groupIdx);
  });

  it("changes nothing when absent — a mandate-less prompt is byte-identical", () => {
    const withoutField = buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw" });
    const withUndefined = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      mandateContext: undefined,
    });
    expect(withUndefined).toBe(withoutField);
    expect(withoutField).not.toContain("## THE MANDATE");
  });
});
