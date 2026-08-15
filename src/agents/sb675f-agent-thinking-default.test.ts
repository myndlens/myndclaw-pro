// SB675f (MyndLens Addendum 101l) — the agent lane honors the PER-AGENT
// thinkingDefault. Live root, mandate_a3a32779: agents.list[].thinkingDefault
// "low" with a gemini-2.5-pro primary was ignored by the embedded agent lane
// (only agents.defaults applied) — vertex 400 "thinking_budget 0" on every
// call, mandate dead in 16s. The schema has documented the per-agent field as
// an override all along; the auto-reply lane honors it. These pins drive the
// extracted resolver agent-command now consults before the fleet default.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentThinkingDefault } from "./agent-scope.js";

const cfg = {
  agents: {
    defaults: { thinkingDefault: "off" },
    list: [{ id: "cat_investing_markets", thinkingDefault: "low" }, { id: "cat_communication" }],
  },
} as unknown as OpenClawConfig;

describe("SB675f — per-agent thinkingDefault on the agent lane", () => {
  it("returns the agent's own declared level (the live pilot shape)", () => {
    expect(resolveAgentThinkingDefault(cfg, "cat_investing_markets")).toBe("low");
  });

  it("returns undefined when the agent declares none — fleet default applies", () => {
    expect(resolveAgentThinkingDefault(cfg, "cat_communication")).toBeUndefined();
  });

  it("returns undefined for an unknown agent — never invents a level", () => {
    expect(resolveAgentThinkingDefault(cfg, "cat_ghost")).toBeUndefined();
  });

  it("normalizes the agent id before matching", () => {
    expect(resolveAgentThinkingDefault(cfg, "CAT_INVESTING_MARKETS")).toBe("low");
  });
});
