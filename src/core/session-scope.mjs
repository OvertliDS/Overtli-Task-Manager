import crypto from 'node:crypto';

export function normalizeSessionId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function resolveSessionId(args = {}, env = process.env) {
  return normalizeSessionId(
    args.sessionId
    || args.session_id
    || env.OTM_SESSION_ID
    || env.CODEX_THREAD_ID
  );
}

export function sessionScopeKey(sessionId) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
