import './support/temp-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunTransition, assertTaskTransition, RUN_TRANSITIONS, TASK_TRANSITIONS } from '../src/core/state-machine.mjs';

test('authoritative task transition matrix permits only documented lifecycle edges', () => {
  for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
    for (const to of targets) assert.doesNotThrow(() => assertTaskTransition(from, to));
  }
  assert.throws(() => assertTaskTransition('pending', 'done', { taskId: 'task-1' }), (error) => error.code === 'INVALID_TRANSITION' && error.details.from === 'pending' && error.details.to === 'done');
  assert.throws(() => assertTaskTransition('done', 'dropped'), { code: 'INVALID_TRANSITION' });
});

test('authoritative run transition matrix rejects reopening terminal history', () => {
  for (const [from, targets] of Object.entries(RUN_TRANSITIONS)) {
    for (const to of targets) assert.doesNotThrow(() => assertRunTransition(from, to));
  }
  assert.throws(() => assertRunTransition('archived', 'active', { runId: 'run-1' }), { code: 'INVALID_TRANSITION' });
  assert.throws(() => assertRunTransition('completed', 'active'), { code: 'INVALID_TRANSITION' });
});
