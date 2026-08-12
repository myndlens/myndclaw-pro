import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";

const state = vi.hoisted(() => ({
  abortEmbeddedPiRunMock: vi.fn(),
  requestEmbeddedRunModelSwitchMock: vi.fn(),
  consumeEmbeddedRunModelSwitchMock: vi.fn(),
  resolveDefaultModelForAgentMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
}));

vi.mock("./pi-embedded.js", () => ({
  abortEmbeddedPiRun: (...args: unknown[]) => state.abortEmbeddedPiRunMock(...args),
}));

vi.mock("./pi-embedded-runner/runs.js", () => ({
  requestEmbeddedRunModelSwitch: (...args: unknown[]) =>
    state.requestEmbeddedRunModelSwitchMock(...args),
  consumeEmbeddedRunModelSwitch: (...args: unknown[]) =>
    state.consumeEmbeddedRunModelSwitchMock(...args),
}));

vi.mock("./model-selection.js", () => ({
  resolveDefaultModelForAgent: (...args: unknown[]) =>
    state.resolveDefaultModelForAgentMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: (...args: unknown[]) => state.loadSessionStoreMock(...args),
  resolveStorePath: (...args: unknown[]) => state.resolveStorePathMock(...args),
}));

async function loadModule() {
  return await importFreshModule<typeof import("./live-model-switch.js")>(
    import.meta.url,
    `./live-model-switch.js?scope=${Math.random().toString(36).slice(2)}`,
  );
}

describe("live model switch", () => {
  beforeEach(() => {
    vi.resetModules();
    state.abortEmbeddedPiRunMock.mockReset().mockReturnValue(false);
    state.requestEmbeddedRunModelSwitchMock.mockReset();
    state.consumeEmbeddedRunModelSwitchMock.mockReset();
    state.resolveDefaultModelForAgentMock
      .mockReset()
      .mockReturnValue({ provider: "anthropic", model: "claude-opus-4-6" });
    state.loadSessionStoreMock.mockReset().mockReturnValue({});
    state.resolveStorePathMock.mockReset().mockReturnValue("/tmp/session-store.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves persisted session overrides ahead of agent defaults", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        authProfileOverride: "profile-gpt",
        authProfileOverrideSource: "user",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-gpt",
      authProfileIdSource: "user",
    });
    expect(state.resolveDefaultModelForAgentMock).toHaveBeenCalledWith({
      cfg: { session: { store: "/tmp/custom-store.json" } },
      agentId: "reply",
    });
    expect(state.resolveStorePathMock).toHaveBeenCalledWith("/tmp/custom-store.json", {
      agentId: "reply",
    });
  });

  it("SB665e: no explicit override means NO live switch — the agent default is not a switch", async () => {
    // The old fallback-to-default made every model-fallback candidate read as
    // a live switch, and the pre-attempt guard vetoed the whole fallback lane
    // (live: si_3 terminals, 2026-08-12). An entry with no override fields —
    // the shape of every mandate session measured on the runtime VPS — must
    // resolve to null.
    state.loadSessionStoreMock.mockReturnValue({
      main: { sessionId: "s-1", model: "gpt-oss-120b", modelProvider: "cerebras" },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
      }),
    ).toBeNull();
  });

  it("SB665e: a missing entry resolves to null, never to the default-as-switch", async () => {
    state.loadSessionStoreMock.mockReturnValue({});

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "absent",
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
      }),
    ).toBeNull();
  });

  it("queues a live switch only when an active run was aborted", async () => {
    state.abortEmbeddedPiRunMock.mockReturnValue(true);

    const { requestLiveSessionModelSwitch } = await loadModule();

    expect(
      requestLiveSessionModelSwitch({
        sessionEntry: { sessionId: "session-1" },
        selection: { provider: "openai", model: "gpt-5.4", authProfileId: "profile-gpt" },
      }),
    ).toBe(true);
    expect(state.abortEmbeddedPiRunMock).toHaveBeenCalledWith("session-1");
    expect(state.requestEmbeddedRunModelSwitchMock).toHaveBeenCalledWith("session-1", {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-gpt",
    });
  });

  it("treats auth-profile-source changes as no-op when no auth profile is selected", async () => {
    const { hasDifferentLiveSessionModelSelection } = await loadModule();

    expect(
      hasDifferentLiveSessionModelSelection(
        {
          provider: "openai",
          model: "gpt-5.4",
          authProfileIdSource: "auto",
        },
        {
          provider: "openai",
          model: "gpt-5.4",
        },
      ),
    ).toBe(false);
  });
});
