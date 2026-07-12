import './support/temp-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskManager } from '../src/core/manager.mjs';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-lifecycle-test-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

function env(name) {
  return { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `${name}-state-`)) };
}

function internalStepStatuses(task) {
  return (task.internalSteps || task.metadata?.internalSteps || []).map((step) => step.status);
}

function completeAllStepsAndTask(manager, workspaceRoot, taskId, scope = {}) {
  for (const step of manager.store.getTask(taskId).metadata.internalSteps) {
    manager.progress({ workspaceRoot, taskId, internalStepId: step.id, internalStepStatus: 'done', message: `Completed ${step.title}.`, ...scope });
  }
  manager.completeTask({ workspaceRoot, taskId, evidence: { kind: 'test_result', summary: 'Verified completion.' }, ...scope });
}

test('terminal task transitions terminalize internal steps and reject stale progress', () => {
  const workspaceRoot = workspace();
  const manager = createTaskManager({ cwd: workspaceRoot, env: env('otm-terminal-transitions') });
  const started = manager.start({
    workspaceRoot,
    goal: 'Terminal transitions',
    tasks: [{ title: 'Drop this', internalSteps: ['Inspect', 'Implement'] }, { title: 'Keep this', internalSteps: ['Continue'] }]
  });
  const droppedId = started.snapshot.tasks[0].id;
  manager.dropTask({ workspaceRoot, taskId: droppedId, reason: 'No longer required.' });
  assert.equal(manager.store.getTask(droppedId).status, 'dropped');
  assert.deepEqual(internalStepStatuses(manager.store.getTask(droppedId)), ['skipped', 'skipped']);
  const next = manager.snapshot({ workspaceRoot, write: false }).snapshot.tasks.find((task) => task.title === 'Keep this');
  assert.equal(next.status, 'active');
  assert.deepEqual(internalStepStatuses(next), ['active']);
  assert.throws(() => manager.progress({ workspaceRoot, taskId: droppedId, message: 'Stale update.' }), /Cannot record progress for a task in status dropped/);
});

test('public route creation rejects terminal task states and duplicate task identifiers', () => {
  const workspaceRoot = workspace();
  const manager = createTaskManager({ cwd: workspaceRoot, env: env('otm-initial-state') });
  assert.throws(() => manager.start({ workspaceRoot, goal: 'Unsafe start', tasks: [{ title: 'Bypass', status: 'done' }] }), /Initial route tasks must be pending or active/);
  assert.throws(() => manager.start({ workspaceRoot, goal: 'Duplicate ids', tasks: [{ id: 'same', title: 'One' }, { id: 'same', title: 'Two' }] }), /Duplicate task id/);
  assert.throws(() => manager.start({ workspaceRoot, goal: 'Oversized title', tasks: [{ title: 'x'.repeat(501) }] }), { code: 'INPUT_TOO_LARGE' });
  assert.throws(() => manager.start({ workspaceRoot, goal: 'Invalid priority', tasks: [{ title: 'Task', priority: 1_001 }] }), { code: 'INVALID_INPUT' });
  assert.throws(() => manager.start({ workspaceRoot, goal: 'Too many criteria', tasks: [{ title: 'Task', acceptanceCriteria: Array.from({ length: 129 }, (_, index) => `criterion ${index}`) }] }), { code: 'INPUT_TOO_LARGE' });
});

test('completion cannot be forced and completed tasks must reopen before drop', () => {
  const workspaceRoot = workspace();
  const manager = createTaskManager({ cwd: workspaceRoot, env: env('otm-transition-guards') });
  const started = manager.start({ workspaceRoot, goal: 'Transition guards', tasks: [{ title: 'Guarded', internalSteps: ['Verify'] }] });
  const taskId = started.snapshot.tasks[0].id;
  manager.progress({ workspaceRoot, taskId, internalStepIndex: 0, internalStepStatus: 'done', message: 'Verified.' });
  assert.throws(() => manager.completeTask({ workspaceRoot, taskId, force: true }), /Forced completion/);
  manager.completeTask({ workspaceRoot, taskId, evidence: { kind: 'test', summary: 'Passed.' } });
  assert.throws(() => manager.dropTask({ workspaceRoot, taskId, reason: 'Rewrite history' }), /explicitly reopened/);
  assert.equal(manager.store.getRun(started.run.id).status, 'ready_to_finalize');
});

test('ordinary activation cannot bypass the explicit blocked-task resume transition', () => {
  const workspaceRoot = workspace();
  const manager = createTaskManager({ cwd: workspaceRoot, env: env('otm-blocked-activation') });
  const started = manager.start({ workspaceRoot, goal: 'Resume guarded task', tasks: [{ title: 'Blocked task' }] });
  const taskId = started.snapshot.tasks[0].id;
  manager.blockTask({ workspaceRoot, taskId, reason: 'Awaiting an external dependency.' });
  assert.throws(() => manager.markTaskActive({ workspaceRoot, taskId }), { code: 'INVALID_TRANSITION' });
  const resumed = manager.resumeRun({ workspaceRoot, runId: started.run.id, taskId, reason: 'Dependency is available.' });
  assert.equal(resumed.run.status, 'active');
  assert.equal(manager.store.getTask(taskId).status, 'active');
});

test('direct lifecycle evidence applies the same bounded validation as MCP input', () => {
  const workspaceRoot = workspace();
  const manager = createTaskManager({ cwd: workspaceRoot, env: env('otm-evidence-bounds') });
  const started = manager.start({ workspaceRoot, goal: 'Validate direct evidence', tasks: [{ title: 'Record bounded evidence' }] });
  const taskId = started.snapshot.tasks[0].id;
  assert.throws(() => manager.progress({ workspaceRoot, taskId, message: 'Too large', evidence: { kind: 'test_result', summary: 'x'.repeat(16_001) } }), { code: 'INPUT_TOO_LARGE' });
  assert.throws(() => manager.progress({ workspaceRoot, taskId, message: 'Too many files', evidence: { kind: 'test_result', summary: 'bounded', files: Array.from({ length: 129 }, (_, index) => `file-${index}`) } }), { code: 'INPUT_TOO_LARGE' });
  assert.throws(() => manager.progress({ workspaceRoot, taskId, message: 'Invalid exit code', evidence: { kind: 'test_result', summary: 'bounded', exitCode: 256 } }), { code: 'INVALID_INPUT' });
});

test('different finalized runs with the same goal retain independent turn-summary memory', () => {
  const workspaceRoot = workspace();
  const manager = createTaskManager({ cwd: workspaceRoot, env: env('otm-summary-memory-identity') });
  const first = manager.start({ workspaceRoot, sessionId: 'first', goal: 'Shared goal', tasks: [{ title: 'First task' }] });
  completeAllStepsAndTask(manager, workspaceRoot, first.snapshot.tasks[0].id, { sessionId: 'first', runId: first.run.id });
  manager.finalizeTurn({ workspaceRoot, sessionId: 'first', operationId: 'first-finalization' });
  const second = manager.start({ workspaceRoot, sessionId: 'second', goal: 'Shared goal', tasks: [{ title: 'Second task' }] });
  completeAllStepsAndTask(manager, workspaceRoot, second.snapshot.tasks[0].id, { sessionId: 'second', runId: second.run.id });
  manager.finalizeTurn({ workspaceRoot, sessionId: 'second', operationId: 'second-finalization' });
  const summaries = manager.store.listCache(workspaceRoot, 100).filter((entry) => entry.kind === 'turn_summary');
  assert.equal(summaries.length, 2);
  assert.equal(new Set(summaries.map((entry) => entry.id)).size, 2);
  assert.deepEqual(new Set(summaries.map((entry) => entry.source.runId)), new Set([first.run.id, second.run.id]));
});

test('clear reports a redacted history-maintenance failure instead of silently discarding it', () => {
  const workspaceRoot = workspace('otm-clear-maintenance-warning-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: env('otm-clear-maintenance-warning') });
  const started = manager.start({ workspaceRoot, goal: 'Clear with visible maintenance diagnostic', tasks: [{ title: 'Complete work' }] });
  completeAllStepsAndTask(manager, workspaceRoot, started.snapshot.tasks[0].id);
  manager.finalizeTurn({ workspaceRoot });
  const originalPrune = manager.store.pruneHistory;
  manager.store.pruneHistory = () => { throw new Error('token=history-maintenance-secret'); };
  try {
    const cleared = manager.clearCurrent({ workspaceRoot });
    assert.equal(cleared.cleared, true);
    assert.equal(cleared.maintenance.pruned, null);
    assert.match(cleared.markdown, /Maintenance warning/);
    assert.doesNotMatch(cleared.markdown, /history-maintenance-secret/);
    assert.match(cleared.markdown, /\[REDACTED\]/);
  } finally {
    manager.store.pruneHistory = originalPrune;
  }
});
