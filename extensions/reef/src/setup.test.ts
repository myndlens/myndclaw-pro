import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

const events: string[] = [];

vi.mock("../protocol/index.js", () => ({ fingerprint: () => "reef-fingerprint" }));
vi.mock("./state.js", () => ({
  resolveStateDir: (configured?: string) => configured ?? "/tmp/reef",
  generateAndStoreKeys: vi.fn(async () => {
    events.push("store keys");
    return { signing: { publicKey: "signing-key" }, encryption: { publicKey: "encryption-key" } };
  }),
}));
vi.mock("./transport.js", () => ({
  ReefTransportClient: class {
    async createHandle() {
      events.push("create handle");
    }
  },
}));

import { reefSetupWizard } from "./setup.js";

describe("reefSetupWizard", () => {
  it("declares its persistence boundary before writing keys or creating the handle", async () => {
    events.length = 0;
    const answers: Record<string, string> = {
      "Reef relay URL": "https://reef.example",
      Email: "alice@example.com",
      "Existing setup session (optional)": "setup-session",
      "Handle (without @)": "alice",
      "Local Reef state directory": "/tmp/reef",
      "Pinned guard model snapshot": "claude-sonnet-4-6",
      "Guard API key environment variable name": "ANTHROPIC_API_KEY",
      "Guard policy version": "reef-v1",
    };

    await reefSetupWizard.configureInteractive({
      cfg: {} as OpenClawConfig,
      prompter: {
        note: vi.fn(async () => undefined),
        text: vi.fn(async ({ message }: { message: string }) => answers[message] ?? ""),
        select: vi.fn(async ({ message }: { message: string }) =>
          message === "Guard provider" ? "anthropic" : "code-only",
        ),
      },
      options: {
        beforePersistentEffect: vi.fn(async () => {
          events.push("persistence boundary");
        }),
      },
    });

    expect(events).toEqual(["persistence boundary", "store keys", "create handle"]);
  });
});
