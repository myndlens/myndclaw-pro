import { loadSessionStore, resolveStorePath, type SessionEntry } from "../config/sessions.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import {
  consumeEmbeddedRunModelSwitch,
  requestEmbeddedRunModelSwitch,
  type EmbeddedRunModelSwitchRequest,
} from "./pi-embedded-runner/runs.js";
import { abortEmbeddedPiRun } from "./pi-embedded.js";

export type LiveSessionModelSelection = EmbeddedRunModelSwitchRequest;

export class LiveSessionModelSwitchError extends Error {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";

  constructor(selection: LiveSessionModelSelection) {
    super(`Live session model switch requested: ${selection.provider}/${selection.model}`);
    this.name = "LiveSessionModelSwitchError";
    this.provider = selection.provider;
    this.model = selection.model;
    this.authProfileId = selection.authProfileId;
    this.authProfileIdSource = selection.authProfileIdSource;
  }
}

export function resolveLiveSessionModelSelection(params: {
  cfg?: { session?: { store?: string } } | undefined;
  sessionKey?: string;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
}): LiveSessionModelSelection | null {
  const sessionKey = params.sessionKey?.trim();
  const cfg = params.cfg;
  if (!cfg || !sessionKey) {
    return null;
  }
  const agentId = params.agentId?.trim();
  const defaultModelRef = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
      })
    : { provider: params.defaultProvider, model: params.defaultModel };
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId,
  });
  const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
  // SB665e (myndlens, Addendum 72): a live switch exists ONLY when the session
  // entry carries an EXPLICIT override (written by the user /model lane,
  // auto-reply/reply/session.ts:482). The old form fell back to the agent
  // default, so during model-fallback every non-default candidate read as a
  // "switch" and the run.ts pre-attempt guard vetoed the entire fallback lane
  // (measured live: si_3 terminals on mandate_3cab8cf7 / mandate_ca463cc4,
  // 2026-08-12 — zero fallback attempts ever ran). No override -> no switch.
  const hasExplicitOverride = Boolean(
    entry?.providerOverride?.trim() ||
    entry?.modelOverride?.trim() ||
    entry?.authProfileOverride?.trim(),
  );
  if (!hasExplicitOverride) {
    return null;
  }
  const provider = entry?.providerOverride?.trim() || defaultModelRef.provider;
  const model = entry?.modelOverride?.trim() || defaultModelRef.model;
  const authProfileId = entry?.authProfileOverride?.trim() || undefined;
  return {
    provider,
    model,
    authProfileId,
    authProfileIdSource: authProfileId ? entry?.authProfileOverrideSource : undefined,
  };
}

export function requestLiveSessionModelSwitch(params: {
  sessionEntry?: Pick<SessionEntry, "sessionId">;
  selection: LiveSessionModelSelection;
}): boolean {
  const sessionId = params.sessionEntry?.sessionId?.trim();
  if (!sessionId) {
    return false;
  }
  const aborted = abortEmbeddedPiRun(sessionId);
  if (!aborted) {
    return false;
  }
  requestEmbeddedRunModelSwitch(sessionId, params.selection);
  return true;
}

export function consumeLiveSessionModelSwitch(
  sessionId: string,
): LiveSessionModelSelection | undefined {
  return consumeEmbeddedRunModelSwitch(sessionId);
}

export function hasDifferentLiveSessionModelSelection(
  current: {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: string;
  },
  next: LiveSessionModelSelection | null | undefined,
): next is LiveSessionModelSelection {
  if (!next) {
    return false;
  }
  return (
    current.provider !== next.provider ||
    current.model !== next.model ||
    (current.authProfileId?.trim() || undefined) !== next.authProfileId ||
    (current.authProfileId?.trim() ? current.authProfileIdSource : undefined) !==
      next.authProfileIdSource
  );
}
