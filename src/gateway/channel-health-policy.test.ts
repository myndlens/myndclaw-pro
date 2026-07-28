import { describe, expect, it } from "vitest";
import { evaluateChannelHealth, resolveChannelRestartReason } from "./channel-health-policy.js";

function evaluateDiscordHealth(
  account: Record<string, unknown>,
  now = 100_000,
  channelId = "discord",
) {
  return evaluateChannelHealth(account, {
    channelId,
    now,
    channelConnectGraceMs: 10_000,
    staleEventThresholdMs: 30_000,
  });
}

describe("evaluateChannelHealth", () => {
  // SB639 — a revoked (401) or conflicted (440) session is a credential state a restart
  // cannot repair; the monitor must leave it alone until a human relinks. Restarting it
  // was the mechanism that hammered device re-registrations against dead credentials.
  it("leaves a logged-out channel alone, even when not running", () => {
    const evaluation = evaluateDiscordHealth({
      running: false,
      enabled: true,
      configured: true,
      healthState: "logged-out",
    });
    expect(evaluation).toEqual({ healthy: true, reason: "terminal-credential-state" });
  });

  it("leaves a conflicted channel alone, even when stale", () => {
    const evaluation = evaluateDiscordHealth({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      healthState: "conflict",
      lastStartAt: 1_000,
      lastEventAt: 1_000, // 99s stale — would be stale-socket without the exemption
    });
    expect(evaluation).toEqual({ healthy: true, reason: "terminal-credential-state" });
  });

  it("a non-terminal healthState still gets normal evaluation", () => {
    const evaluation = evaluateDiscordHealth({
      running: false,
      enabled: true,
      configured: true,
      healthState: "reconnecting",
    });
    expect(evaluation).toEqual({ healthy: false, reason: "not-running" });
  });

  it("treats disabled accounts as healthy unmanaged", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: false,
        enabled: false,
        configured: true,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("uses channel connect grace before flagging disconnected", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: 95_000,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("treats active runs as busy even when disconnected", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 30_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("flags stale busy channels as stuck when run activity is too old", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 26 * 60_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("flags stale sockets when no events arrive beyond threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("skips stale-socket detection for telegram long-polling channels", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: null,
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("skips stale-socket detection for channels in webhook mode", () => {
    const evaluation = evaluateDiscordHealth({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lastStartAt: 0,
      lastEventAt: 0,
      mode: "webhook",
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets for channels without event tracking", () => {
    const evaluation = evaluateDiscordHealth({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lastStartAt: 0,
      lastEventAt: null,
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets without an active connected socket", () => {
    const evaluation = evaluateDiscordHealth(
      {
        running: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("ignores inherited event timestamps from a previous lifecycle", () => {
    const evaluation = evaluateDiscordHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastEventAt: 10_000,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags inherited event timestamps after the lifecycle exceeds the stale threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastEventAt: 10_000,
      },
      {
        channelId: "slack",
        now: 140_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });
});

describe("resolveChannelRestartReason", () => {
  it("maps not-running + high reconnect attempts to gave-up", () => {
    const reason = resolveChannelRestartReason(
      {
        running: false,
        reconnectAttempts: 10,
      },
      { healthy: false, reason: "not-running" },
    );
    expect(reason).toBe("gave-up");
  });

  it("maps disconnected to disconnected instead of stuck", () => {
    const reason = resolveChannelRestartReason(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
      },
      { healthy: false, reason: "disconnected" },
    );
    expect(reason).toBe("disconnected");
  });
});
