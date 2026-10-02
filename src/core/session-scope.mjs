import crypto from "node:crypto";
import { OtmError } from "./errors.mjs";

export function normalizeSessionId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

export function resolveSessionId(args = {}, env = process.env) {
  const identities = [
    ["sessionId", args.sessionId],
    ["session_id", args.session_id],
    ["threadId", args.threadId],
    ["thread_id", args.thread_id],
    ["conversationId", args.conversationId],
    ["conversation_id", args.conversation_id],
    ["OTM_SESSION_ID", env.OTM_SESSION_ID],
    ["CODEX_THREAD_ID", env.CODEX_THREAD_ID],
  ]
    .map(([source, value]) => ({ source, value: normalizeSessionId(value) }))
    .filter((item) => item.value);
  const distinct = new Set(identities.map((item) => item.value));
  if (distinct.size > 1) {
    throw new OtmError(
      "Conflicting Codex session identities were supplied; OTM did not select a route.",
      {
        code: "SESSION_IDENTITY_CONFLICT",
        details: { sources: identities.map((item) => item.source) },
      },
    );
  }
  return normalizeSessionId(
    args.sessionId ||
      args.session_id ||
      args.threadId ||
      args.thread_id ||
      args.conversationId ||
      args.conversation_id ||
      env.OTM_SESSION_ID ||
      env.CODEX_THREAD_ID,
  );
}

export function sessionScopeKey(sessionId) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
}
