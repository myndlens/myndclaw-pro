import "./test-helpers.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createScriptedWebListenerFactory,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  startWebAutoReplyMonitor,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

// SB639 — the storm class. A WhatsApp-initiated credential failure (401 revoked, 440
// conflict, 403 forbidden) must be TERMINAL on the CONNECT path exactly as it already was on
// the steady-state close path. Before this, a rejected connect escaped the monitor loop
// entirely: the gateway supervisor treated a credential revocation as a crash and hammered
// device re-registrations against dead credentials — the abuse signature that got a real
// account restricted (2026-07-28).
describe("SB639 connect-path classification", () => {
  installWebAutoReplyUnitTestHooks();

  let monitorWebChannel: typeof import("./auto-reply.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply.js"));
  });

  function rejectingFactory(status: number | undefined) {
    let calls = 0;
    const listenerFactory = async () => {
      calls += 1;
      if (status === undefined) {
        throw new Error("Connection closed");
      }
      // Baileys connect rejections carry lastDisconnect shape: { error: Boom, date }.
      throw { error: { output: { statusCode: status } }, date: new Date() };
    };
    return { listenerFactory, getCalls: () => calls };
  }

  it("a 401 during connect is terminal: one attempt, no retry, no throw to the supervisor", async () => {
    const { listenerFactory, getCalls } = rejectingFactory(401);
    const sleep = vi.fn(async () => {});
    const { runtime, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
    });
    await run; // resolves — a revoked session must never reject out to the supervisor
    expect(getCalls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("401 during connect"));
  });

  for (const status of [440, 403]) {
    it(`a ${status} during connect is terminal: one attempt, no retry`, async () => {
      const { listenerFactory, getCalls } = rejectingFactory(status);
      const sleep = vi.fn(async () => {});
      const { runtime, run } = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory,
        sleep,
      });
      await run;
      expect(getCalls()).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("non-retryable"));
    });
  }

  it("a generic connect failure retries with backoff and stops at maxAttempts", async () => {
    const { listenerFactory, getCalls } = rejectingFactory(undefined);
    const sleep = vi.fn(async () => {});
    const { runtime, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 3, factor: 1.1 },
    });
    await run;
    expect(getCalls()).toBe(3);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("max attempts reached"));
  });

  it("sustained 503 during connect trips the breaker before max attempts", async () => {
    const { listenerFactory, getCalls } = rejectingFactory(503);
    const sleep = vi.fn(async () => {});
    const { runtime, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 20, factor: 1.1 },
    });
    await run;
    expect(getCalls()).toBe(8);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("503 x8"));
  });

  it("a quiet >heartbeat uptime does NOT reset the backoff counter; socket traffic does", async () => {
    // Before SB639, ANY >heartbeat stretch reset reconnectAttempts, so computeBackoff always
    // saw attempt=1 — "Retry 1/∞ in 2.2s" forever, measured live at ~41 relinks/day.
    const sleep = vi.fn(async () => {});
    const scripted = createScriptedWebListenerFactory();
    const { runtime, controller, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory: scripted.listenerFactory,
      sleep,
      heartbeatSeconds: 1,
      reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 10, factor: 1.1 },
    });

    await vi.waitFor(() => expect(scripted.getListenerCount()).toBe(1), {
      timeout: 500,
      interval: 5,
    });
    // Quiet uptime past the heartbeat, then a close: attempts must SURVIVE the stretch.
    await new Promise((r) => setTimeout(r, 1100));
    scripted.resolveClose(0, { status: 500, isLoggedOut: false });
    await vi.waitFor(() => expect(scripted.getListenerCount()).toBe(2), {
      timeout: 500,
      interval: 5,
    });
    await new Promise((r) => setTimeout(r, 1100));
    scripted.resolveClose(1, { status: 500, isLoggedOut: false });
    await vi.waitFor(() => expect(scripted.getListenerCount()).toBe(3), {
      timeout: 500,
      interval: 5,
    });
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Retry 2/10"));

    // Now real socket traffic through the ingress tap, a >heartbeat stretch, and a close:
    // the counter resets — an EVIDENCED healthy stretch, not an inferred one.
    const opts = scripted.listenerFactory.mock.calls[2]?.[0] as {
      onIngress?: (raw: unknown) => void;
    };
    await new Promise((r) => setTimeout(r, 1100));
    opts.onIngress?.({
      key: { id: "SB639", remoteJid: "1555@s.whatsapp.net", fromMe: false },
      message: { conversation: "liveness" },
    });
    scripted.resolveClose(2, { status: 500, isLoggedOut: false });
    await vi.waitFor(() => expect(scripted.getListenerCount()).toBe(4), {
      timeout: 500,
      interval: 5,
    });
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Retry 1/10"));

    controller.abort();
    scripted.resolveClose(3, { status: 500, isLoggedOut: false });
    await run;
  }, 15000);
});
