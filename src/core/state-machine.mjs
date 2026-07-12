import { OtmError } from './errors.mjs';

export const TASK_TRANSITIONS = Object.freeze({
  pending: new Set(['active', 'dropped', 'superseded']),
  active: new Set(['pending', 'done', 'blocked', 'dropped', 'superseded']),
  blocked: new Set(['active', 'pending', 'dropped', 'superseded']),
  done: new Set(['active', 'pending']),
  dropped: new Set(['active', 'pending']),
  superseded: new Set(['active', 'pending'])
});

export const RUN_TRANSITIONS = Object.freeze({
  active: new Set(['ready_to_finalize', 'blocked', 'completed', 'abandoned']),
  ready_to_finalize: new Set(['active', 'completed', 'blocked', 'abandoned']),
  blocked: new Set(['active', 'completed', 'cleared', 'abandoned']),
  paused: new Set(['active', 'abandoned']),
  completed: new Set(['cleared', 'abandoned', 'archived']),
  cleared: new Set(['abandoned', 'archived']),
  abandoned: new Set(['archived']),
  archived: new Set()
});

export function assertTaskTransition(from, to, details = {}) {
  assertTransition(TASK_TRANSITIONS, 'task', from, to, details);
}

export function assertRunTransition(from, to, details = {}) {
  assertTransition(RUN_TRANSITIONS, 'run', from, to, details);
}

function assertTransition(matrix, type, from, to, details) {
  if (from === to) return;
  if (matrix[from]?.has(to)) return;
  throw new OtmError(`Invalid ${type} transition from ${String(from)} to ${String(to)}.`, {
    code: 'INVALID_TRANSITION',
    details: { entity: type, from, to, ...details }
  });
}
