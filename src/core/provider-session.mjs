import { OtmError } from "./errors.mjs";
import { sha256 } from "./ids.mjs";
import { normalizeSessionId } from "./session-scope.mjs";

export const PROVIDER_IDS = Object.freeze(["codex", "claude"]);

export const CLAUDE_HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
]);

const PROVIDERS = new Set(PROVIDER_IDS);
const CLAUDE_HOOK_EVENT_SET = new Set(CLAUDE_HOOK_EVENTS);
const CLAUDE_SUBAGENT_EVENTS = new Set(["SubagentStart", "SubagentStop"]);
const CLAUDE_SESSION_PREFIX = "otm-provider:claude:v1:";

/**
 * Resolve a trusted host session into the identity used by OTM storage.
 * Codex deliberately keeps its historical raw identity; Claude receives a
 * stable, opaque namespace so the two providers cannot normally alias routes.
 */
export function createProviderSession({ provider, nativeSessionId } = {}) {
  if (!PROVIDERS.has(provider)) {
    throw new OtmError("Unsupported OTM provider.", {
      code: "INVALID_PROVIDER",
      details: { allowed: PROVIDER_IDS },
    });
  }

  if (typeof nativeSessionId !== "string") {
    throw new OtmError("A trusted provider session id must be a string.", {
      code: "PROVIDER_SESSION_REQUIRED",
    });
  }
  const nativeId = normalizeSessionId(nativeSessionId);
  if (!nativeId) {
    throw new OtmError("A trusted provider session id is required.", {
      code: "PROVIDER_SESSION_REQUIRED",
    });
  }

  const digest = sha256(`overtli-task-manager\0${provider}\0${nativeId}`);
  const sessionId =
    provider === "codex" ? nativeId : `${CLAUDE_SESSION_PREFIX}${digest}`;

  return Object.freeze({
    provider,
    sessionId,
    providerSessionKey: `${provider}:${digest}`,
  });
}

/**
 * Map already-authenticated, signed host claims into an OTM session. Callers
 * must verify the Claude capability signature before using this function.
 */
export function createVerifiedProviderSession(claims = {}) {
  const digestMatch = /^otm-provider:claude:v1:([a-f0-9]{64})$/.exec(
    String(claims.sessionId || ""),
  );
  const digest = digestMatch?.[1];
  if (
    claims.provider !== "claude" ||
    !digest ||
    claims.providerSessionKey !== `claude:${digest}` ||
    typeof claims.nativeSessionId !== "string" ||
    !claims.nativeSessionId.trim()
  ) {
    throw new OtmError("Authenticated Claude session claims are invalid.", {
      code: "PROVIDER_SESSION_REQUIRED",
    });
  }
  const derived = createProviderSession({
    provider: "claude",
    nativeSessionId: claims.nativeSessionId,
  });
  if (
    derived.sessionId !== claims.sessionId ||
    derived.providerSessionKey !== claims.providerSessionKey
  ) {
    throw new OtmError("Authenticated Claude session claims do not match their session id.", {
      code: "PROVIDER_SESSION_REQUIRED",
    });
  }
  return Object.freeze({
    provider: "claude",
    sessionId: claims.sessionId,
    providerSessionKey: claims.providerSessionKey,
    nativeSessionId: claims.nativeSessionId,
  });
}

/**
 * Map the official Claude Code hook identity fields into provider identities.
 * Call only from a trusted Claude hook/request boundary: payload fields are
 * validated here, but this helper cannot authenticate the sender.
 */
export function mapClaudeHookPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new OtmError("Claude hook payload must be an object.", {
      code: "INVALID_CLAUDE_HOOK_PAYLOAD",
    });
  }

  const eventName = payload.hook_event_name;
  if (!CLAUDE_HOOK_EVENT_SET.has(eventName)) {
    throw new OtmError("Unsupported Claude hook event.", {
      code: "UNSUPPORTED_CLAUDE_HOOK_EVENT",
      details: { allowed: CLAUDE_HOOK_EVENTS },
    });
  }

  const session = createProviderSession({
    provider: "claude",
    nativeSessionId: payload.session_id,
  });
  let agentId = null;
  if (payload.agent_id !== undefined && payload.agent_id !== null) {
    if (typeof payload.agent_id !== "string" || !payload.agent_id.trim()) {
      throw new OtmError("Claude agent_id must be a non-empty string.", {
        code: "INVALID_CLAUDE_HOOK_PAYLOAD",
      });
    }
    agentId = payload.agent_id.trim();
  }

  if (CLAUDE_SUBAGENT_EVENTS.has(eventName) && !agentId) {
    throw new OtmError(`${eventName} requires the official agent_id field.`, {
      code: "CLAUDE_AGENT_ID_REQUIRED",
    });
  }

  return Object.freeze({
    provider: "claude",
    eventName,
    nativeSessionId: payload.session_id.trim(),
    session,
    agentId,
    ...(CLAUDE_SUBAGENT_EVENTS.has(eventName)
      ? { workerNativeSessionId: agentId }
      : {}),
  });
}

/**
 * Remove host-specific session identities before a provider-scoped manager is
 * created. Callers must pass the trusted identity explicitly on each request.
 */
export function createProviderEnvironment(env = process.env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new OtmError("A provider environment object is required.", {
      code: "INVALID_PROVIDER_ENVIRONMENT",
    });
  }

  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !["OTM_SESSION_ID", "CODEX_THREAD_ID"].includes(key.toUpperCase()),
    ),
  );
}
