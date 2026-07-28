import { resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/channel-runtime";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { waitForever } from "openclaw/plugin-sdk/cli-runtime";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  defaultRuntime,
  formatDurationPrecise,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount, resolveWhatsAppMediaMaxBytes } from "../accounts.js";
import { setActiveWebListener } from "../active-listener.js";
import { monitorWebInbox } from "../inbound.js";
import { type IngressStore, openIngressStore } from "../inbound/ingress-store.js";
import {
  computeBackoff,
  newConnectionId,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  sleepWithAbort,
} from "../reconnect.js";
import { formatError, getWebAuthAgeMs, readWebSelfId } from "../session.js";
import { whatsappHeartbeatLog, whatsappLog } from "./loggers.js";
import { buildMentionConfig } from "./mentions.js";
import { createWebChannelStatusController } from "./monitor-state.js";
import { createEchoTracker } from "./monitor/echo.js";
import { createWebOnMessageHandler } from "./monitor/on-message.js";
import type { WebInboundMsg, WebMonitorTuning } from "./types.js";
import { isLikelyWhatsAppCryptoError } from "./util.js";

function isNonRetryableWebCloseStatus(statusCode: unknown): boolean {
  // WhatsApp 440 = session conflict ("Unknown Stream Errored (conflict)").
  // This is persistent until the operator resolves the conflicting session.
  // SB639: 401 = session revoked, 403 = forbidden/banned — both are credential states no
  // amount of retrying can repair; retrying them from a datacenter IP is the abuse signature
  // that gets an account restricted. Terminal until a human relinks.
  return statusCode === 440 || statusCode === 401 || statusCode === 403;
}

// SB639: a connect-time rejection arrives as Baileys' lastDisconnect ({ error: Boom, date })
// or as a bare Error. Pull the web status code out of either shape.
function connectErrorStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const rec = err as {
    error?: { output?: { statusCode?: number } };
    output?: { statusCode?: number };
  };
  const code = rec.error?.output?.statusCode ?? rec.output?.statusCode;
  return typeof code === "number" ? code : undefined;
}

// SB639: sustained 503 (service unavailable) is not a blip after this many close/connect
// failures in a row with no successful connection between them.
const SERVICE_UNAVAILABLE_BREAKER = 8;

type ActiveConnectionRun = {
  connectionId: string;
  startedAt: number;
  heartbeat: NodeJS.Timeout | null;
  watchdogTimer: NodeJS.Timeout | null;
  lastInboundAt: number | null;
  handledMessages: number;
  unregisterUnhandled: (() => void) | null;
  backgroundTasks: Set<Promise<unknown>>;
};

function createActiveConnectionRun(lastInboundAt: number | null): ActiveConnectionRun {
  return {
    connectionId: newConnectionId(),
    startedAt: Date.now(),
    heartbeat: null,
    watchdogTimer: null,
    lastInboundAt,
    handledMessages: 0,
    unregisterUnhandled: null,
    backgroundTasks: new Set<Promise<unknown>>(),
  };
}

/**
 * SB638 — one capture store per process, opened lazily on the first message.
 *
 * Lazy because a failure to open must not stop the channel from RUNNING: delivery and the
 * health clock are independent of capture. It is retried on the next message, and the failure
 * is loud each time it is attempted (Doctrine 1) — a silently uncaptured channel is exactly
 * the state that produced the incident this fixes.
 */
let ingressStore: IngressStore | null = null;
let ingressStoreFailed = false;

function getIngressStore(): IngressStore | null {
  if (ingressStore) {
    return ingressStore;
  }
  try {
    ingressStore = openIngressStore({
      onError: (err) => {
        getChildLogger({ module: "wa-ingress-store" }).error(
          { error: String(err) },
          "SB638 capture write FAILED — this message did not reach Signal Memory",
        );
      },
    });
    ingressStoreFailed = false;
    return ingressStore;
  } catch (err) {
    if (!ingressStoreFailed) {
      getChildLogger({ module: "wa-ingress-store" }).error(
        { error: String(err) },
        "SB638 capture store could not be opened — WhatsApp capture is DOWN (delivery unaffected)",
      );
      ingressStoreFailed = true;
    }
    return null;
  }
}

export async function monitorWebChannel(
  verbose: boolean,
  listenerFactory: typeof monitorWebInbox | undefined = monitorWebInbox,
  keepAlive = true,
  replyResolver: typeof getReplyFromConfig | undefined = getReplyFromConfig,
  runtime: RuntimeEnv = defaultRuntime,
  abortSignal?: AbortSignal,
  tuning: WebMonitorTuning = {},
) {
  const runId = newConnectionId();
  const replyLogger = getChildLogger({ module: "web-auto-reply", runId });
  const heartbeatLogger = getChildLogger({ module: "web-heartbeat", runId });
  const reconnectLogger = getChildLogger({ module: "web-reconnect", runId });
  const statusController = createWebChannelStatusController(tuning.statusSink);
  const status = statusController.snapshot();
  statusController.emit();

  const baseCfg = loadConfig();
  const account = resolveWhatsAppAccount({
    cfg: baseCfg,
    accountId: tuning.accountId,
  });
  const cfg = {
    ...baseCfg,
    channels: {
      ...baseCfg.channels,
      whatsapp: {
        ...baseCfg.channels?.whatsapp,
        ackReaction: account.ackReaction,
        messagePrefix: account.messagePrefix,
        allowFrom: account.allowFrom,
        groupAllowFrom: account.groupAllowFrom,
        groupPolicy: account.groupPolicy,
        textChunkLimit: account.textChunkLimit,
        chunkMode: account.chunkMode,
        mediaMaxMb: account.mediaMaxMb,
        blockStreaming: account.blockStreaming,
        groups: account.groups,
      },
    },
  } satisfies ReturnType<typeof loadConfig>;

  const maxMediaBytes = resolveWhatsAppMediaMaxBytes(account);
  const heartbeatSeconds = resolveHeartbeatSeconds(cfg, tuning.heartbeatSeconds);
  const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
  const baseMentionConfig = buildMentionConfig(cfg);
  const groupHistoryLimit =
    cfg.channels?.whatsapp?.accounts?.[tuning.accountId ?? ""]?.historyLimit ??
    cfg.channels?.whatsapp?.historyLimit ??
    cfg.messages?.groupChat?.historyLimit ??
    DEFAULT_GROUP_HISTORY_LIMIT;
  const groupHistories = new Map<
    string,
    Array<{
      sender: string;
      body: string;
      timestamp?: number;
      id?: string;
      senderJid?: string;
    }>
  >();
  const groupMemberNames = new Map<string, Map<string, string>>();
  const echoTracker = createEchoTracker({ maxItems: 100, logVerbose });

  const sleep =
    tuning.sleep ??
    ((ms: number, signal?: AbortSignal) => sleepWithAbort(ms, signal ?? abortSignal));
  const stopRequested = () => abortSignal?.aborted === true;
  const abortPromise =
    abortSignal &&
    new Promise<"aborted">((resolve) =>
      abortSignal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      }),
    );

  // Avoid noisy MaxListenersExceeded warnings in test environments where
  // multiple gateway instances may be constructed.
  const currentMaxListeners = process.getMaxListeners?.() ?? 10;
  if (process.setMaxListeners && currentMaxListeners < 50) {
    process.setMaxListeners(50);
  }

  let sigintStop = false;
  const handleSigint = () => {
    sigintStop = true;
  };
  process.once("SIGINT", handleSigint);

  let reconnectAttempts = 0;
  // SB639: never reset — the resettable counter feeds backoff; this one is for visibility.
  // 41 relinks/day rendered as INFO lines is how the storm stayed invisible for weeks.
  let lifetimeReconnects = 0;
  let consecutiveServiceUnavailable = 0;
  const serviceUnavailableBreakerTripped = (statusCode: unknown): boolean => {
    consecutiveServiceUnavailable = statusCode === 503 ? consecutiveServiceUnavailable + 1 : 0;
    return consecutiveServiceUnavailable >= SERVICE_UNAVAILABLE_BREAKER;
  };

  while (true) {
    if (stopRequested()) {
      break;
    }

    const active = createActiveConnectionRun(status.lastInboundAt ?? status.lastMessageAt ?? null);

    // Watchdog to detect stuck message processing (e.g., event emitter died).
    // Tuning overrides are test-oriented; production defaults remain unchanged.
    const MESSAGE_TIMEOUT_MS = tuning.messageTimeoutMs ?? 30 * 60 * 1000; // 30m default
    const WATCHDOG_CHECK_MS = tuning.watchdogCheckMs ?? 60 * 1000; // 1m default

    const onMessage = createWebOnMessageHandler({
      cfg,
      verbose,
      connectionId: active.connectionId,
      maxMediaBytes,
      groupHistoryLimit,
      groupHistories,
      groupMemberNames,
      echoTracker,
      backgroundTasks: active.backgroundTasks,
      replyResolver: replyResolver ?? getReplyFromConfig,
      replyLogger,
      baseMentionConfig,
      account,
    });

    const inboundDebounceMs = resolveInboundDebounceMs({ cfg, channel: "whatsapp" });
    const shouldDebounce = (msg: WebInboundMsg) => {
      if (msg.mediaPath || msg.mediaType) {
        return false;
      }
      if (msg.location) {
        return false;
      }
      if (msg.replyToId || msg.replyToBody) {
        return false;
      }
      return !hasControlCommand(msg.body, cfg);
    };

    let listener: Awaited<ReturnType<typeof monitorWebInbox>>;
    try {
      listener = await (listenerFactory ?? monitorWebInbox)({
        verbose,
        accountId: account.accountId,
        authDir: account.authDir,
        mediaMaxMb: account.mediaMaxMb,
        sendReadReceipts: account.sendReadReceipts,
        debounceMs: inboundDebounceMs,
        shouldDebounce,
        // SB638 — the health clock now tracks the SOCKET, not the reply pipeline. Before this,
        // noteInbound fired only from onMessage below, which is reachable only when the
        // access-control gate ALLOWS a reply; under `dmPolicy: "disabled"` it never fired, so
        // lastEventAt froze and the health monitor relinked the device forever on phantom
        // staleness (channel-health-policy stale-socket, 30-min threshold). A message arriving
        // IS liveness, whatever the reply posture.
        onIngress: (raw) => {
          // SB639 — the per-run clock too: the message-processing watchdog and the backoff
          // reset both key off active.lastInboundAt, and both must see socket traffic under
          // a closed reply gate, for the same reason as the health clock above.
          active.lastInboundAt = Date.now();
          statusController.noteInbound(active.lastInboundAt);
          // SB638 — capture every message, in and out, above every policy gate. This store is
          // what Signal Memory reads; it is the reason the channel no longer has to be taken
          // DOWN nightly for a bootstrap session to harvest messages.
          getIngressStore()?.record(account.accountId, raw);
        },
        onMessage: async (msg: WebInboundMsg) => {
          active.handledMessages += 1;
          active.lastInboundAt = Date.now();
          statusController.noteInbound(active.lastInboundAt);
          await onMessage(msg);
        },
      });
    } catch (err) {
      // SB639 — a rejected CONNECT used to escape this loop entirely: the gateway supervisor
      // then treated a credential revocation as a crash and hammered relink attempts against
      // dead creds (the post-restriction storm). Classify here, exactly like a close.
      const statusCode = connectErrorStatusCode(err);
      const errorStr = formatError(err);
      reconnectLogger.warn(
        {
          connectionId: active.connectionId,
          status: statusCode ?? "unknown",
          reconnectAttempts,
          lifetimeReconnects,
          error: errorStr,
        },
        "web reconnect: connect attempt failed",
      );
      if (isNonRetryableWebCloseStatus(statusCode)) {
        const loggedOut = statusCode === 401;
        statusController.noteClose({
          statusCode,
          loggedOut,
          error: errorStr,
          reconnectAttempts,
          healthState: loggedOut ? "logged-out" : "conflict",
        });
        runtime.error(
          loggedOut
            ? `WhatsApp session logged out (401 during connect). Run \`${formatCliCommand("openclaw channels login --channel web")}\` to relink. Stopping web monitoring.`
            : `WhatsApp Web connect failed (status ${statusCode}: non-retryable). Resolve the session state, then relink with \`${formatCliCommand("openclaw channels login --channel web")}\`. Stopping web monitoring.`,
        );
        break;
      }
      if (serviceUnavailableBreakerTripped(statusCode)) {
        statusController.noteClose({
          statusCode,
          error: errorStr,
          reconnectAttempts,
          healthState: "stopped",
        });
        runtime.error(
          `WhatsApp Web connect failed with 503 x${consecutiveServiceUnavailable} in a row. Stopping web monitoring.`,
        );
        break;
      }
      reconnectAttempts += 1;
      lifetimeReconnects += 1;
      if (reconnectAttempts >= reconnectPolicy.maxAttempts) {
        statusController.noteClose({
          statusCode,
          error: errorStr,
          reconnectAttempts,
          healthState: "stopped",
        });
        runtime.error(
          `WhatsApp Web reconnect: max attempts reached (${reconnectAttempts}/${reconnectPolicy.maxAttempts}). Stopping web monitoring.`,
        );
        break;
      }
      statusController.noteClose({
        statusCode,
        error: errorStr,
        reconnectAttempts,
        healthState: "reconnecting",
      });
      const delay = computeBackoff(reconnectPolicy, reconnectAttempts);
      runtime.error(
        `WhatsApp Web connect failed (status ${statusCode ?? "unknown"}). Retry ${reconnectAttempts}/${reconnectPolicy.maxAttempts} in ${formatDurationPrecise(delay)}… (${errorStr})`,
      );
      try {
        await sleep(delay, abortSignal);
      } catch {
        break;
      }
      continue;
    }

    statusController.noteConnected();
    consecutiveServiceUnavailable = 0;

    // Surface a concise connection event for the next main-session turn/heartbeat.
    const { e164: selfE164 } = readWebSelfId(account.authDir);
    const connectRoute = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: account.accountId,
    });
    enqueueSystemEvent(`WhatsApp gateway connected${selfE164 ? ` as ${selfE164}` : ""}.`, {
      sessionKey: connectRoute.sessionKey,
    });

    setActiveWebListener(account.accountId, listener);
    active.unregisterUnhandled = registerUnhandledRejectionHandler((reason) => {
      if (!isLikelyWhatsAppCryptoError(reason)) {
        return false;
      }
      const errorStr = formatError(reason);
      reconnectLogger.warn(
        { connectionId: active.connectionId, error: errorStr },
        "web reconnect: unhandled rejection from WhatsApp socket; forcing reconnect",
      );
      listener.signalClose?.({
        status: 499,
        isLoggedOut: false,
        error: reason,
      });
      return true;
    });

    const closeListener = async () => {
      setActiveWebListener(account.accountId, null);
      if (active.unregisterUnhandled) {
        active.unregisterUnhandled();
        active.unregisterUnhandled = null;
      }
      if (active.heartbeat) {
        clearInterval(active.heartbeat);
      }
      if (active.watchdogTimer) {
        clearInterval(active.watchdogTimer);
      }
      if (active.backgroundTasks.size > 0) {
        await Promise.allSettled(active.backgroundTasks);
        active.backgroundTasks.clear();
      }
      try {
        await listener.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${formatError(err)}`);
      }
    };

    if (keepAlive) {
      active.heartbeat = setInterval(() => {
        const authAgeMs = getWebAuthAgeMs(account.authDir);
        const minutesSinceLastMessage = active.lastInboundAt
          ? Math.floor((Date.now() - active.lastInboundAt) / 60000)
          : null;

        const logData = {
          connectionId: active.connectionId,
          reconnectAttempts,
          lifetimeReconnects,
          messagesHandled: active.handledMessages,
          lastInboundAt: active.lastInboundAt,
          authAgeMs,
          uptimeMs: Date.now() - active.startedAt,
          ...(minutesSinceLastMessage !== null && minutesSinceLastMessage > 30
            ? { minutesSinceLastMessage }
            : {}),
        };

        if (minutesSinceLastMessage && minutesSinceLastMessage > 30) {
          heartbeatLogger.warn(logData, "⚠️ web gateway heartbeat - no messages in 30+ minutes");
        } else {
          heartbeatLogger.info(logData, "web gateway heartbeat");
        }
      }, heartbeatSeconds * 1000);

      active.watchdogTimer = setInterval(() => {
        if (!active.lastInboundAt) {
          return;
        }
        const timeSinceLastMessage = Date.now() - active.lastInboundAt;
        if (timeSinceLastMessage <= MESSAGE_TIMEOUT_MS) {
          return;
        }
        const minutesSinceLastMessage = Math.floor(timeSinceLastMessage / 60000);
        statusController.noteWatchdogStale();
        heartbeatLogger.warn(
          {
            connectionId: active.connectionId,
            minutesSinceLastMessage,
            lastInboundAt: new Date(active.lastInboundAt),
            messagesHandled: active.handledMessages,
          },
          "Message timeout detected - forcing reconnect",
        );
        whatsappHeartbeatLog.warn(
          `No messages received in ${minutesSinceLastMessage}m - restarting connection`,
        );
        void closeListener().catch((err) => {
          logVerbose(`Close listener failed: ${formatError(err)}`);
        });
        listener.signalClose?.({
          status: 499,
          isLoggedOut: false,
          error: "watchdog-timeout",
        });
      }, WATCHDOG_CHECK_MS);
    }

    whatsappLog.info("Listening for personal WhatsApp inbound messages.");
    if (process.stdout.isTTY || process.stderr.isTTY) {
      whatsappLog.raw("Ctrl+C to stop.");
    }

    if (!keepAlive) {
      await closeListener();
      process.removeListener("SIGINT", handleSigint);
      return;
    }

    const reason = await Promise.race([
      listener.onClose?.catch((err) => {
        reconnectLogger.error({ error: formatError(err) }, "listener.onClose rejected");
        return { status: 500, isLoggedOut: false, error: err };
      }) ?? waitForever(),
      abortPromise ?? waitForever(),
    ]);

    const uptimeMs = Date.now() - active.startedAt;
    // SB639: a healthy stretch must be EVIDENCED, not inferred from the clock. Resetting on
    // any >60s uptime meant computeBackoff always saw attempt=1 ("Retry 1/∞ in 2.2s" forever)
    // — the loop never escalated. Traffic through this run's socket (the ingress tap fires
    // for every raw message, in and out) is the evidence; a quiet connection keeps its count.
    const sawSocketTraffic = (active.lastInboundAt ?? 0) > active.startedAt;
    if (uptimeMs > heartbeatSeconds * 1000 && sawSocketTraffic) {
      reconnectAttempts = 0; // Evidenced healthy stretch; reset the backoff.
    }
    statusController.noteReconnectAttempts(reconnectAttempts);

    if (stopRequested() || sigintStop || reason === "aborted") {
      await closeListener();
      break;
    }

    const statusCode =
      (typeof reason === "object" && reason && "status" in reason
        ? (reason as { status?: number }).status
        : undefined) ?? "unknown";
    const loggedOut =
      typeof reason === "object" &&
      reason &&
      "isLoggedOut" in reason &&
      (reason as { isLoggedOut?: boolean }).isLoggedOut;

    const errorStr = formatError(reason);
    const numericStatusCode = typeof statusCode === "number" ? statusCode : undefined;

    reconnectLogger.info(
      {
        connectionId: active.connectionId,
        status: statusCode,
        loggedOut,
        reconnectAttempts,
        error: errorStr,
      },
      "web reconnect: connection closed",
    );

    enqueueSystemEvent(`WhatsApp gateway disconnected (status ${statusCode ?? "unknown"})`, {
      sessionKey: connectRoute.sessionKey,
    });

    if (loggedOut) {
      statusController.noteClose({
        statusCode: numericStatusCode,
        loggedOut: true,
        error: errorStr,
        reconnectAttempts,
        healthState: "logged-out",
      });
      runtime.error(
        `WhatsApp session logged out. Run \`${formatCliCommand("openclaw channels login --channel web")}\` to relink.`,
      );
      await closeListener();
      break;
    }

    if (isNonRetryableWebCloseStatus(statusCode)) {
      const revokedSession = statusCode === 401;
      statusController.noteClose({
        statusCode: numericStatusCode,
        loggedOut: revokedSession,
        error: errorStr,
        reconnectAttempts,
        healthState: revokedSession ? "logged-out" : "conflict",
      });
      reconnectLogger.warn(
        {
          connectionId: active.connectionId,
          status: statusCode,
          error: errorStr,
        },
        "web reconnect: non-retryable close status; stopping monitor",
      );
      runtime.error(
        `WhatsApp Web connection closed (status ${statusCode}: non-retryable). Resolve the session state, then relink with \`${formatCliCommand("openclaw channels login --channel web")}\`. Stopping web monitoring.`,
      );
      await closeListener();
      break;
    }

    if (serviceUnavailableBreakerTripped(statusCode)) {
      statusController.noteClose({
        statusCode: numericStatusCode,
        error: errorStr,
        reconnectAttempts,
        healthState: "stopped",
      });
      runtime.error(
        `WhatsApp Web connection closed with 503 x${consecutiveServiceUnavailable} in a row. Stopping web monitoring.`,
      );
      await closeListener();
      break;
    }

    reconnectAttempts += 1;
    lifetimeReconnects += 1;
    if (reconnectAttempts >= reconnectPolicy.maxAttempts) {
      statusController.noteClose({
        statusCode: numericStatusCode,
        error: errorStr,
        reconnectAttempts,
        healthState: "stopped",
      });
      reconnectLogger.warn(
        {
          connectionId: active.connectionId,
          status: statusCode,
          reconnectAttempts,
          maxAttempts: reconnectPolicy.maxAttempts,
        },
        "web reconnect: max attempts reached; continuing in degraded mode",
      );
      runtime.error(
        `WhatsApp Web reconnect: max attempts reached (${reconnectAttempts}/${reconnectPolicy.maxAttempts}). Stopping web monitoring.`,
      );
      await closeListener();
      break;
    }

    statusController.noteClose({
      statusCode: numericStatusCode,
      error: errorStr,
      reconnectAttempts,
      healthState: "reconnecting",
    });
    const delay = computeBackoff(reconnectPolicy, reconnectAttempts);
    reconnectLogger.info(
      {
        connectionId: active.connectionId,
        status: statusCode,
        reconnectAttempts,
        lifetimeReconnects,
        maxAttempts: reconnectPolicy.maxAttempts,
        delayMs: delay,
      },
      "web reconnect: scheduling retry",
    );
    runtime.error(
      `WhatsApp Web connection closed (status ${statusCode}). Retry ${reconnectAttempts}/${reconnectPolicy.maxAttempts} in ${formatDurationPrecise(delay)}… (${errorStr})`,
    );
    await closeListener();
    try {
      await sleep(delay, abortSignal);
    } catch {
      break;
    }
  }

  statusController.markStopped();

  process.removeListener("SIGINT", handleSigint);
}
