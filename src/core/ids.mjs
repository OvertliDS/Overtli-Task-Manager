import crypto from 'node:crypto';

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function shortHash(value, length = 12) {
  return sha256(value).slice(0, length);
}

export function stableTaskKey(title, acceptanceCriteria = []) {
  const normalized = `${String(title || '').trim().toLowerCase()}\n${acceptanceCriteria.map(String).join('\n').trim().toLowerCase()}`;
  return shortHash(normalized, 16);
}

export function nowIso() {
  return new Date().toISOString();
}
