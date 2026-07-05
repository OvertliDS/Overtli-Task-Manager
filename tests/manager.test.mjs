import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskManager } from '../src/core/manager.mjs';
import { deriveFallbackTasks } from '../src/core/planner.mjs';
import { findWorkspaceRoot, workspaceScratchDir, workspaceTempDir } from '../src/core/fs-utils.mjs';
import { loadBetterSqlite3 } from '../src/storage/sqlite-store.mjs';
import { installWorkspace } from '../src/install/install-workspace.mjs';
import { installGlobal } from '../src/install/install-global.mjs';
import { reviewProjectContext } from '../src/context/project-review.mjs';
import { toMcpResult } from '../src/mcp/result.mjs';
import { runHookScript } from '../src/hooks/runner.mjs';

function tempWorkspace(prefix = 'otm-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Test Workspace\n', 'utf8');
  return root;
}

function testEnv(name) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-state-`));
  return { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: stateDir };
}

function sqliteTestEnv(name) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-sqlite-state-`));
  return { ...process.env, OTM_STORAGE: 'sqlite', OTM_STATE_DIR: stateDir };
}

async function withCapturedStdout(fn) {
  const originalWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = function write(chunk, encoding, callback) {
    captured += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    const result = await fn();
    return { result, captured };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function internalStepTitles(task) {
  return (task.metadata.internalSteps || []).map((step) => typeof step === 'string' ? step : step.title);
}

function internalStepStatuses(task) {
  return (task.metadata.internalSteps || []).map((step) => typeof step === 'string' ? 'pending' : step.status);
}

function finishInternalSteps(manager, workspaceRoot, taskId, statusByTitle = {}) {
  const snapshot = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  const task = snapshot.tasks.find((item) => item.id === taskId);
  for (const step of task?.metadata?.internalSteps || []) {
    const title = typeof step === 'string' ? step : step.title;
    const current = typeof step === 'string' ? 'pending' : step.status;
    if (['done', 'skipped'].includes(current)) continue;
    manager.progress({
      workspaceRoot,
      taskId,
      message: `Internal step complete: ${title}`,
      internalStepTitle: title,
      internalStepStatus: statusByTitle[title] || 'done',
      evidence: { kind: 'internal_step', summary: `Internal step terminal: ${title}` }
    });
  }
}

test('route lifecycle requires evidence and clears after finalization', () => {
  const workspaceRoot = tempWorkspace('otm-route-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-route') });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate route lifecycle',
    prompt: 'Build and validate the route lifecycle.',
    tasks: [
      { title: 'Create route', required: true, acceptanceCriteria: ['Route exists'] },
      { title: 'Validate route', required: true, acceptanceCriteria: ['Audit passes after evidence'] }
    ]
  });
  assert.equal(started.snapshot.status, 'active');
  assert.ok(Array.isArray(started.snapshot.checklist));
  assert.equal(started.snapshot.checklist.length, 2);
  assert.equal(started.snapshot.renderPolicy.mode, 'start_end_delta');
  assert.equal(typeof started.snapshot.lastRenderedHash, 'string');
  assert.doesNotMatch(JSON.stringify(started.snapshot), /:null/);
  const [first, second] = started.snapshot.tasks;
  assert.equal(first.status, 'active');

  manager.markTaskActive({ workspaceRoot, taskId: first.id });
  assert.throws(() => manager.completeTask({ workspaceRoot, taskId: first.id }), /evidence is attached/);
  finishInternalSteps(manager, workspaceRoot, first.id);
  const completedFirst = manager.completeTask({ workspaceRoot, taskId: first.id, evidence: { kind: 'manual_note', summary: 'Route created.' } });
  assert.match(completedFirst.markdown, /^### OTM Progress/);
  assert.equal(completedFirst.snapshot.lastRenderedMode, 'delta');
  assert.equal(completedFirst.snapshot.tasks.find((task) => task.id === second.id).status, 'active');
  assert.equal(manager.auditStop({ workspaceRoot }).stopAllowed, false);

  manager.markTaskActive({ workspaceRoot, taskId: second.id });
  finishInternalSteps(manager, workspaceRoot, second.id);
  manager.completeTask({ workspaceRoot, taskId: second.id, evidence: { kind: 'test_result', summary: 'Audit passed after both tasks.' } });
  assert.equal(manager.auditStop({ workspaceRoot }).stopAllowed, true);

  const scratchDir = workspaceScratchDir(workspaceRoot);
  fs.mkdirSync(scratchDir, { recursive: true });
  const scratchFile = path.join(scratchDir, 'final-clear-dump.txt');
  fs.writeFileSync(scratchFile, 'raw scratch content', 'utf8');

  const finalized = manager.finalizeTurn({ workspaceRoot, clear: true });
  assert.equal(finalized.snapshot.status, 'cleared');
  assert.doesNotMatch(JSON.stringify(finalized.summaryJson), /:null/);
  assert.ok(fs.existsSync(path.join(workspaceRoot, '.codex/overtli-task-manager/current.json')));
  assert.equal(fs.existsSync(scratchFile), false);
});

test('read-only snapshots do not rewrite current state files', async () => {
  const workspaceRoot = tempWorkspace('otm-snapshot-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-snapshot') });
  manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate read-only snapshot',
    tasks: [{ title: 'Keep current files stable', required: true }]
  });
  const currentJson = path.join(workspaceRoot, '.codex/overtli-task-manager/current.json');
  const before = fs.statSync(currentJson).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  manager.snapshot({ workspaceRoot, write: false });
  const after = fs.statSync(currentJson).mtimeMs;
  assert.equal(after, before);
});

test('current state writes use organized temp directory and clean stale state temp files', () => {
  const workspaceRoot = tempWorkspace('otm-temp-clean-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-temp-clean') });
  manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate temp cleanup',
    tasks: [{ title: 'Write current files', required: true }]
  });

  const stateDir = path.join(workspaceRoot, '.codex', 'overtli-task-manager');
  const cacheRoot = path.join(stateDir, 'cache');
  const scratchRoot = workspaceScratchDir(workspaceRoot);
  const staleCurrent = path.join(stateDir, 'current.md.1234.1000.tmp');
  const staleJson = path.join(stateDir, 'current.json.5678.1000.tmp');
  const staleCache = path.join(cacheRoot, 'project-review.json.9012.1000.tmp');
  const staleScratch = path.join(scratchRoot, 'old-raw-dump.txt');
  const unrelated = path.join(stateDir, 'user-note.tmp');
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.mkdirSync(scratchRoot, { recursive: true });
  fs.writeFileSync(staleCurrent, 'stale markdown temp', 'utf8');
  fs.writeFileSync(staleJson, '{}\n', 'utf8');
  fs.writeFileSync(staleCache, '{}\n', 'utf8');
  fs.writeFileSync(staleScratch, 'old scratch payload', 'utf8');
  fs.writeFileSync(unrelated, 'keep me', 'utf8');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const veryOld = new Date(Date.now() - 45 * 60 * 1000);
  fs.utimesSync(staleCurrent, old, old);
  fs.utimesSync(staleJson, old, old);
  fs.utimesSync(staleCache, old, old);
  fs.utimesSync(staleScratch, veryOld, veryOld);

  manager.progress({ workspaceRoot, message: 'Force current state rewrite.' });

  assert.equal(fs.existsSync(staleCurrent), false);
  assert.equal(fs.existsSync(staleJson), false);
  assert.equal(fs.existsSync(staleCache), false);
  assert.equal(fs.existsSync(staleScratch), false);
  assert.equal(fs.existsSync(unrelated), true);
  assert.ok(fs.existsSync(workspaceTempDir(workspaceRoot)));
  const leaked = fs.readdirSync(stateDir).filter((name) => /^current\.(?:md|json)\.\d+\.\d+\.tmp$/.test(name));
  assert.deepEqual(leaked, []);
  const tempLeaked = fs.readdirSync(workspaceTempDir(workspaceRoot)).filter((name) => /\.tmp$/.test(name));
  assert.deepEqual(tempLeaked, []);
});

test('explicit cleanup removes OTM-owned temp and scratch artifacts immediately', () => {
  const workspaceRoot = tempWorkspace('otm-explicit-clean-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-explicit-clean') });
  manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate explicit cleanup',
    tasks: [{ title: 'Create cleanup artifacts', required: true }]
  });

  const stateDir = path.join(workspaceRoot, '.codex', 'overtli-task-manager');
  const scratchRoot = workspaceScratchDir(workspaceRoot);
  fs.mkdirSync(scratchRoot, { recursive: true });
  const tempFile = path.join(stateDir, 'current.json.1234.2000.tmp');
  const scratchFile = path.join(scratchRoot, 'raw-dump.txt');
  const keepFile = path.join(stateDir, 'keep.tmp');
  fs.writeFileSync(tempFile, '{}\n', 'utf8');
  fs.writeFileSync(scratchFile, 'raw scratch content', 'utf8');
  fs.writeFileSync(keepFile, 'not owned by OTM cleanup', 'utf8');

  const result = manager.cleanupWorkspace({ workspaceRoot });

  assert.equal(fs.existsSync(tempFile), false);
  assert.equal(fs.existsSync(scratchFile), false);
  assert.equal(fs.existsSync(keepFile), true);
  assert.equal(result.removed.length, 2);
  assert.match(result.markdown, /Removed artifact\(s\): 2/);
});

test('history pruning defaults to durable cleanup while preserving active routes', () => {
  const workspaceRoot = tempWorkspace('otm-prune-history-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-prune-history') });
  const oldIso = '2026-06-20T00:00:00.000Z';
  const recentNow = '2026-07-04T00:00:00.000Z';

  const oldRun = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Old completed route',
    tasks: [{ title: 'Finish old route', required: true }]
  }).run;
  const oldTask = manager.snapshot({ workspaceRoot, write: false }).snapshot.tasks[0];
  finishInternalSteps(manager, workspaceRoot, oldTask.id);
  manager.completeTask({
    workspaceRoot,
    taskId: oldTask.id,
    evidence: { kind: 'test_result', summary: 'Old route completed.' }
  });
  manager.finalizeTurn({ workspaceRoot, clear: true });
  manager.store.updateRun(oldRun.id, { status: 'cleared', updatedAt: oldIso, finalizedAt: oldIso });
  manager.store.upsertSummary({
    id: 'summary_old',
    runId: oldRun.id,
    workspaceRoot,
    turnId: 'manual',
    summaryMd: 'old summary',
    summaryJson: { old: true },
    currentCleared: true,
    createdAt: oldIso
  });
  manager.store.upsertCache({
    id: 'cache_old',
    workspaceRoot,
    kind: 'turn_summary',
    title: 'Old cache',
    body: 'old cache body',
    tags: ['turn-summary'],
    source: {},
    scoreHint: 0,
    createdAt: oldIso,
    updatedAt: oldIso,
    expiresAt: null
  });

  const activeRun = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Old but active route',
    tasks: [{ title: 'Keep active route', required: true }]
  }).run;
  manager.store.updateRun(activeRun.id, { status: 'active', updatedAt: oldIso, finalizedAt: null });

  const dryRun = manager.pruneHistory({ workspaceRoot, now: recentNow, dryRun: true });
  assert.equal(dryRun.retentionDays, 7);
  assert.equal(dryRun.deleted.runs, 1);
  assert.equal(dryRun.deleted.tasks, 1);
  assert.ok(dryRun.deleted.events >= 1);
  assert.equal(dryRun.deleted.summaries, 2);
  assert.ok(dryRun.deleted.cacheEntries >= 1);
  assert.ok(manager.store.getRun(oldRun.id));

  const pruned = manager.pruneHistory({ workspaceRoot, now: recentNow });
  assert.equal(pruned.deleted.runs, 1);
  assert.equal(manager.store.getRun(oldRun.id), null);
  assert.ok(manager.store.getRun(activeRun.id));
  assert.equal(manager.store.getTasks(oldRun.id).length, 0);
  assert.equal(manager.store.getEvents(oldRun.id).length, 0);
  assert.equal(manager.store.listSummaries(workspaceRoot, 20).some((summary) => summary.runId === oldRun.id), false);
  assert.equal(manager.store.listCache(workspaceRoot, 20).some((entry) => entry.id === 'cache_old'), false);
  assert.match(pruned.markdown, /Retention: 7 day/);
});

test('sqlite history pruning removes old inactive rows', { skip: !loadBetterSqlite3() }, () => {
  const workspaceRoot = tempWorkspace('otm-sqlite-prune-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: sqliteTestEnv('otm-sqlite-prune') });
  const oldIso = '2026-06-20T00:00:00.000Z';
  const now = '2026-07-04T00:00:00.000Z';

  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Old sqlite route',
    tasks: [{ title: 'Complete old sqlite route', required: true }]
  });
  const taskId = started.snapshot.tasks[0].id;
  finishInternalSteps(manager, workspaceRoot, taskId);
  manager.completeTask({
    workspaceRoot,
    taskId,
    evidence: { kind: 'test_result', summary: 'Old sqlite route complete.' }
  });
  manager.finalizeTurn({ workspaceRoot, clear: true });
  manager.store.updateRun(started.run.id, { status: 'cleared', updatedAt: oldIso, finalizedAt: oldIso });

  const dryRun = manager.pruneHistory({ workspaceRoot, now, dryRun: true });
  assert.equal(dryRun.deleted.runs, 1);
  assert.ok(manager.store.getRun(started.run.id));

  const pruned = manager.pruneHistory({ workspaceRoot, now });
  assert.equal(pruned.deleted.runs, 1);
  assert.equal(manager.store.getRun(started.run.id), null);
  assert.equal(manager.store.getTasks(started.run.id).length, 0);
});

test('post-tool hook stores long raw command input in scratchpad instead of route evidence', async () => {
  const workspaceRoot = tempWorkspace('otm-scratchpad-');
  const env = testEnv('otm-scratchpad');
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate scratchpad evidence',
    tasks: [{ title: 'Capture hook evidence', required: true }]
  });

  const rawCommand = 'apply patch payload\n'.repeat(120);
  await withCapturedStdout(() => runHookScript('post-tool-use', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({
      tool_name: 'apply_patch',
      tool_input: { command: rawCommand },
      tool_response: { status: 0 }
    })
  }));

  const snapshot = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  const evidence = snapshot.tasks[0].evidence.at(-1);
  assert.match(evidence.command, /^\[omitted long apply_patch input; saved to /);
  assert.ok(evidence.notes.scratchFile);
  const scratchPath = path.join(workspaceRoot, evidence.notes.scratchFile);
  assert.equal(fs.readFileSync(scratchPath, 'utf8'), rawCommand);
  assert.equal(JSON.stringify(snapshot).includes(rawCommand), false);
});

test('reconcile preserves model task order and activates newly added work by insertion order', () => {
  const workspaceRoot = tempWorkspace('otm-order-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-order') });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate model ordering',
    tasks: [
      { title: 'Implement route feature', required: true },
      { title: 'Run final audit and clear route', required: true },
      { title: 'Update README docs', required: true }
    ]
  });

  finishInternalSteps(manager, workspaceRoot, started.snapshot.tasks[0].id);
  manager.completeTask({
    workspaceRoot,
    taskId: started.snapshot.tasks[0].id,
    evidence: { kind: 'file_change', summary: 'Feature implemented.' }
  });

  const snapshot = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  assert.equal(snapshot.currentTaskTitle, 'Run final audit and clear route');
  assert.equal(snapshot.tasks.find((task) => task.title === 'Run final audit and clear route').status, 'active');
  assert.deepEqual(snapshot.tasks.map((task) => task.title), [
    'Implement route feature',
    'Run final audit and clear route',
    'Update README docs'
  ]);

  const auditTaskId = snapshot.tasks.find((task) => task.title === 'Run final audit and clear route').id;
  finishInternalSteps(manager, workspaceRoot, auditTaskId);
  manager.completeTask({
    workspaceRoot,
    taskId: auditTaskId,
    evidence: { kind: 'test_result', summary: 'Audit verified.' }
  });
  manager.reconcile({
    workspaceRoot,
    mode: 'steer',
    tasks: [{ title: 'Fix status accuracy', required: true, acceptanceCriteria: ['Current task table matches header'] }]
  });

  const afterAudit = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  assert.equal(afterAudit.currentTaskTitle, 'Update README docs');
  assert.equal(afterAudit.tasks.find((task) => task.title === 'Update README docs').status, 'active');
  assert.equal(afterAudit.tasks.find((task) => task.title === 'Fix status accuracy').status, 'pending');
});

test('manual task switching is blocked until the active task is completed or reconciled', () => {
  const workspaceRoot = tempWorkspace('otm-sequential-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-sequential') });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate sequential task handling',
    tasks: [
      { title: 'Handle first task', required: true },
      { title: 'Handle second task', required: true }
    ]
  });
  const [first, second] = started.snapshot.tasks;
  assert.equal(first.status, 'active');

  assert.throws(
    () => manager.markTaskActive({ workspaceRoot, taskId: second.id }),
    /Complete or explicitly reconcile the active task before moving on/
  );
  assert.throws(
    () => manager.progress({ workspaceRoot, taskId: second.id, message: 'Trying to jump ahead.' }),
    /Complete or explicitly reconcile the active task before moving on/
  );

  manager.reconcile({
    workspaceRoot,
    mode: 'steer',
    changes: [{ action: 'activate', taskId: second.id, reason: 'Explicit steering switch' }]
  });
  const switched = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  assert.equal(switched.currentTaskId, second.id);
  assert.equal(switched.tasks.find((task) => task.id === second.id).status, 'active');
  assert.equal(switched.tasks.find((task) => task.id === first.id).status, 'pending');
});

test('explicit reconcile activation overrides current model order when the model steers route focus', () => {
  const workspaceRoot = tempWorkspace('otm-activate-rank-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-activate-rank') });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate explicit route steering',
    tasks: [
      { title: 'Globally reinstall latest package and hooks', required: true },
      { title: 'Update docs for route behavior', required: true }
    ]
  });
  const docsTask = started.snapshot.tasks.find((task) => task.title === 'Update docs for route behavior');

  assert.equal(started.snapshot.currentTaskTitle, 'Globally reinstall latest package and hooks');

  manager.reconcile({
    workspaceRoot,
    mode: 'steer',
    changes: [{ action: 'activate', taskId: docsTask.id, reason: 'Model identified docs work before reinstall' }]
  });

  const steered = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  assert.equal(steered.currentTaskTitle, 'Update docs for route behavior');
  assert.equal(steered.tasks.find((task) => task.id === docsTask.id).status, 'active');
  assert.equal(steered.tasks.find((task) => task.title === 'Globally reinstall latest package and hooks').status, 'pending');
});

test('reconcile merges related open tasks, adds distinct tasks, and stores internal substeps', () => {
  const workspaceRoot = tempWorkspace('otm-merge-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-merge') });
  manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate steering normalization',
    tasks: [{ title: 'Optimize render behavior', required: true, acceptanceCriteria: ['Render policy is stable'] }]
  });

  manager.reconcile({
    workspaceRoot,
    tasks: [{
      title: 'Optimize rendering behavior',
      required: true,
      acceptanceCriteria: ['Compact progress stays fast'],
      internalSteps: ['Profile current render path', 'Avoid unnecessary writes']
    }]
  });
  let tasks = manager.snapshot({ workspaceRoot, write: false }).snapshot.tasks;
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].acceptanceCriteria, ['Render policy is stable', 'Compact progress stays fast']);
  assert.deepEqual(internalStepTitles(tasks[0]), [
    'Render policy is stable',
    'Profile current render path',
    'Avoid unnecessary writes'
  ]);
  assert.deepEqual(internalStepStatuses(tasks[0]), ['active', 'pending', 'pending']);

  manager.reconcile({
    workspaceRoot,
    tasks: [{ title: 'Update install docs', required: true, acceptanceCriteria: ['README is current'] }]
  });
  tasks = manager.snapshot({ workspaceRoot, write: false }).snapshot.tasks;
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].title, 'Update install docs');
  assert.doesNotMatch(manager.snapshot({ workspaceRoot, write: false }).markdown, /Profile current render path/);
});

test('reconcile can explicitly reopen completed tasks without losing evidence', () => {
  const workspaceRoot = tempWorkspace('otm-reopen-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-reopen') });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate reopening',
    tasks: [{ title: 'Validate docs', required: true, acceptanceCriteria: ['Docs checked'] }]
  });
  const taskId = started.snapshot.tasks[0].id;
  finishInternalSteps(manager, workspaceRoot, taskId);
  manager.completeTask({
    workspaceRoot,
    taskId,
    evidence: { kind: 'test_result', summary: 'Initial docs check passed.' }
  });
  assert.equal(manager.auditStop({ workspaceRoot }).stopAllowed, true);

  manager.reconcile({
    workspaceRoot,
    changes: [{ action: 'reopen', taskId, reason: 'User requested another docs pass' }]
  });
  const reopened = manager.snapshot({ workspaceRoot, write: false }).snapshot.tasks.find((task) => task.id === taskId);
  assert.equal(reopened.status, 'active');
  assert.ok(reopened.evidence.some((item) => item.summary === 'Initial docs check passed.'));
  assert.deepEqual(reopened.metadata.internalSteps.map((step) => step.status), ['active']);
  assert.equal(reopened.metadata.reopened.at(-1).previousStatus, 'done');
  assert.equal(manager.auditStop({ workspaceRoot }).stopAllowed, false);
});

test('fallback planner promotes explicit phases and deliverables to route segments with internal steps', () => {
  const prompt = `Fully implement these phases now:
Phase 1: Fix prompt route segmentation
Phase 2: Preserve internal task details
Phase 3: Add regression tests
Then git commit and push.
Then reinstall the latest version globally.`;

  const tasks = deriveFallbackTasks(prompt, { goal: 'Improve route planning' });
  const titles = tasks.map((task) => task.title);

  assert.ok(titles.includes('Fix prompt route segmentation'));
  assert.ok(titles.includes('Resolve Preserve internal task details'));
  assert.ok(titles.includes('Add regression tests'));
  assert.ok(titles.includes('Commit and push changes'));
  assert.ok(titles.includes('Reinstall the latest version globally'));
  assert.ok(titles.includes('Validate behavior and check for regressions'));
  assert.ok(titles.includes('Summarize outcome and clear active checklist'));

  const segmentation = tasks.find((task) => task.title === 'Fix prompt route segmentation');
  assert.deepEqual(segmentation.internalSteps, [
    'Inspect current behavior and affected files for Fix prompt route segmentation',
    'Identify explicit, inferred, and discovered work needed for Fix prompt route segmentation',
    'Implement the complete fix or change for Fix prompt route segmentation',
    'Run targeted checks and record evidence for Fix prompt route segmentation'
  ]);
});

test('fallback planner separates plain issue bullets without collapsing them into one generic fix', () => {
  const prompt = `Fix these issues:
- login button does nothing
- settings page shows stale status
- export crashes on missing path`;

  const tasks = deriveFallbackTasks(prompt);
  const titles = tasks.map((task) => task.title);

  assert.ok(titles.includes('Resolve login button does nothing'));
  assert.ok(titles.includes('Resolve settings page shows stale status'));
  assert.ok(titles.includes('Resolve export crashes on missing path'));
  assert.equal(titles.includes('Implement the requested change set'), false);
});

test('fallback planner treats planning-only phase lists as documentation or planning work', () => {
  const prompt = `Create a phase plan for later implementation:
1. Runtime install lane
2. Model manager UX
3. Diagnostics repair flow`;

  const tasks = deriveFallbackTasks(prompt);
  const titles = tasks.map((task) => task.title);

  assert.ok(titles.includes('Plan Runtime install lane'));
  assert.ok(titles.includes('Plan Model manager UX'));
  assert.ok(titles.includes('Plan Diagnostics repair flow'));
  assert.equal(titles.includes('Validate behavior and check for regressions'), false);
  assert.match(tasks.find((task) => task.title === 'Plan Runtime install lane').internalSteps[2], /Draft or update/);
});

test('model-supplied route segments from rich prompt context preserve internal steps', () => {
  const workspaceRoot = tempWorkspace('otm-model-route-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-model-route') });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Fix UI issues from prompt and screenshot',
    prompt: 'Fix the profile screen issues shown in chat and screenshot.',
    screenshots: [{ description: 'Screenshot shows Save button hidden behind footer and profile avatar overlapping the title.' }],
    tasks: [
      {
        title: 'Fix hidden Save button on profile screen',
        required: true,
        internalSteps: [
          'Inspect screenshot-visible footer overlap',
          'Find profile screen layout code',
          'Adjust responsive spacing and footer constraints',
          'Verify Save button remains visible on desktop and mobile'
        ],
        acceptanceCriteria: ['Save button is visible and usable in the affected profile screen state']
      },
      {
        title: 'Fix avatar/title overlap on profile screen',
        required: true,
        metadata: {
          internalSteps: [
            'Inspect model-visible screenshot guidance',
            'Locate avatar and title layout styles',
            'Repair spacing without breaking existing profile layout',
            'Verify overlap is gone'
          ]
        },
        acceptanceCriteria: ['Avatar and title no longer overlap']
      }
    ]
  });

  assert.deepEqual(started.snapshot.tasks.map((task) => task.title), [
    'Fix hidden Save button on profile screen',
    'Fix avatar/title overlap on profile screen'
  ]);
  assert.deepEqual(internalStepTitles(started.snapshot.tasks[0]), [
    'Inspect screenshot-visible footer overlap',
    'Find profile screen layout code',
    'Adjust responsive spacing and footer constraints',
    'Verify Save button remains visible on desktop and mobile'
  ]);
  assert.deepEqual(internalStepStatuses(started.snapshot.tasks[0]), ['active', 'pending', 'pending', 'pending']);
  assert.deepEqual(internalStepTitles(started.snapshot.tasks[1]), [
    'Inspect model-visible screenshot guidance',
    'Locate avatar and title layout styles',
    'Repair spacing without breaking existing profile layout',
    'Verify overlap is gone'
  ]);
  assert.match(started.snapshot.tasks[0].description || '', /^$/);
});

test('model-supplied route segments without internal steps get category-aware defaults', () => {
  const workspaceRoot = tempWorkspace('otm-category-steps-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-category-steps') });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Check generated default steps',
    tasks: [
      { title: 'Summarize outcome and clear active checklist' },
      { title: 'Validate behavior and check for regressions' },
      { title: 'Reinstall the latest version globally' },
      { title: 'Update README documentation' },
      { title: 'Implement prompt route segmentation fix' }
    ]
  });

  const byTitle = new Map(started.snapshot.tasks.map((task) => [task.title, internalStepTitles(task)]));
  assert.deepEqual(byTitle.get('Summarize outcome and clear active checklist'), [
    'Reconcile route evidence for Summarize outcome and clear active checklist',
    'Write or present the final summary for Summarize outcome and clear active checklist',
    'Clear active route state only after the stop audit passes for Summarize outcome and clear active checklist',
    'Record finalization evidence for Summarize outcome and clear active checklist'
  ]);
  assert.deepEqual(byTitle.get('Validate behavior and check for regressions'), [
    'Identify the relevant checks for Validate behavior and check for regressions',
    'Run targeted checks for Validate behavior and check for regressions',
    'Inspect failures or regressions for Validate behavior and check for regressions',
    'Record validation evidence for Validate behavior and check for regressions'
  ]);
  assert.deepEqual(byTitle.get('Reinstall the latest version globally'), [
    'Inspect target install state for Reinstall the latest version globally',
    'Run the install or configuration command for Reinstall the latest version globally',
    'Verify install or doctor output for Reinstall the latest version globally',
    'Record install evidence for Reinstall the latest version globally'
  ]);
  assert.deepEqual(byTitle.get('Update README documentation'), [
    'Inspect source-of-truth material for Update README documentation',
    'Draft or update documentation for Update README documentation',
    'Verify commands, paths, and status claims for Update README documentation',
    'Record documentation evidence for Update README documentation'
  ]);
  assert.deepEqual(byTitle.get('Implement prompt route segmentation fix'), [
    'Inspect affected code and existing patterns for Implement prompt route segmentation fix',
    'Implement the complete requested change for Implement prompt route segmentation fix',
    'Update related tests, docs, or configuration for Implement prompt route segmentation fix',
    'Run relevant checks and record evidence for Implement prompt route segmentation fix'
  ]);
});

test('internal step progress persists without completing the route gate', () => {
  const workspaceRoot = tempWorkspace('otm-internal-steps-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-internal-steps') });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Track internal steps',
    tasks: [{
      title: 'Implement tracking change',
      required: true,
      internalSteps: [
        'Inspect current route state',
        'Patch progress updates',
        'Run regression tests'
      ]
    }]
  });
  const taskId = started.snapshot.tasks[0].id;

  const progress = manager.progress({
    workspaceRoot,
    taskId,
    message: 'Finished source inspection.',
    internalStepTitle: 'Inspect current route state',
    internalStepStatus: 'done',
    evidence: { kind: 'manual_note', summary: 'Internal source inspection complete.' }
  });

  const task = progress.snapshot.tasks.find((item) => item.id === taskId);
  assert.equal(task.status, 'active');
  assert.equal(progress.snapshot.stopAllowed, false);
  assert.equal(progress.snapshot.currentInternalStep.title, 'Patch progress updates');
  assert.deepEqual(task.metadata.internalSteps.map((step) => step.status), ['done', 'active', 'pending']);
  assert.match(progress.markdown, /Implement tracking change/);
  assert.match(manager.snapshot({ workspaceRoot, write: false }).markdown, /Internal 1\/3/);
  assert.equal(manager.auditStop({ workspaceRoot }).stopAllowed, false);

  assert.throws(() => manager.completeTask({ workspaceRoot, taskId }), /evidence is attached/);
  assert.throws(
    () => manager.completeTask({
      workspaceRoot,
      taskId,
      evidence: { kind: 'test_result', summary: 'Evidence is present but internal steps are unfinished.' }
    }),
    /Complete all internal steps/
  );
  finishInternalSteps(manager, workspaceRoot, taskId);
  const completed = manager.completeTask({
    workspaceRoot,
    taskId,
    evidence: { kind: 'test_result', summary: 'Top-level gate completed with evidence.' }
  });
  const completedTask = completed.snapshot.tasks.find((item) => item.id === taskId);
  assert.equal(completed.snapshot.stopAllowed, true);
  assert.deepEqual(completedTask.metadata.internalSteps.map((step) => step.status), ['done', 'done', 'done']);
});

test('MCP results return concise text content without structured JSON by default', () => {
  const result = toMcpResult({ markdown: '## OTM\n\nPlain progress.\n', snapshot: { noisy: true } });
  assert.deepEqual(Object.keys(result), ['content']);
  assert.equal(result.content[0].text, '## OTM\n\nPlain progress.\n');

  const fallback = toMcpResult({ stopAllowed: false, remainingRequired: [{ title: 'Finish tests' }] });
  assert.deepEqual(Object.keys(fallback), ['content']);
  assert.match(fallback.content[0].text, /audit blocked/i);
  assert.doesNotMatch(fallback.content[0].text, /remainingRequired/);
});

test('workspace installer is idempotent and preserves existing guidance', () => {
  const workspaceRoot = tempWorkspace('otm-install-');
  fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), '# Existing Guidance\n\nKeep tests passing.\n', 'utf8');
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));

  const first = installWorkspace({ workspaceRoot, packageRoot, dryRun: false });
  const second = installWorkspace({ workspaceRoot, packageRoot, dryRun: false });
  const firstAgents = first.results.find((item) => item.step === 'agents');
  const secondAgents = second.results.find((item) => item.step === 'agents');
  assert.equal(firstAgents.ok, true);
  assert.equal(secondAgents.action, 'unchanged');

  const agents = fs.readFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'utf8');
  assert.equal((agents.match(/OVERTLI-TASK-MANAGER:BEGIN/g) || []).length, 1);
  assert.match(agents, /Keep tests passing/);
  assert.ok(fs.existsSync(path.join(workspaceRoot, '.agents/skills/overtli-task-manager/SKILL.md')));
  assert.ok(fs.existsSync(path.join(workspaceRoot, '.codex/hooks.json')));
  const hooks = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.codex/hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.PreToolUse.at(-1).matcher, 'Bash|apply_patch');
  assert.equal(hooks.PostToolUse.at(-1).matcher, 'Bash|apply_patch');
  assert.equal(hooks.PreToolUse.at(-1).hooks[0].timeout, 8);
  assert.equal(hooks.Stop.at(-1).hooks[0].timeout, 45);
  const expectedCli = path.join(packageRoot, 'bin', 'otm.mjs');
  assert.equal(hooks.SessionStart.at(-1).hooks[0].command, `node "${expectedCli}" hook session-start`);
  assert.equal(hooks.UserPromptSubmit.at(-1).hooks[0].command, `node "${expectedCli}" hook user-prompt-submit`);
  assert.doesNotMatch(hooks.SessionStart.at(-1).hooks[0].command, /\\\\/);
});

test('workspace installer patches AGENTS.md by default and only patches override explicitly', () => {
  const workspaceRoot = tempWorkspace('otm-install-override-');
  fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), '# Root Guidance\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.override.md'), '# Override Guidance\n\nTemporary local rule.\n', 'utf8');
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));

  const first = installWorkspace({ workspaceRoot, packageRoot, dryRun: false });
  const firstAgents = first.results.find((item) => item.step === 'agents');
  assert.equal(firstAgents.ok, true);
  assert.match(firstAgents.warning, /AGENTS\.override\.md exists and was not patched/);
  assert.match(fs.readFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'utf8'), /OVERTLI-TASK-MANAGER:BEGIN/);
  assert.doesNotMatch(fs.readFileSync(path.join(workspaceRoot, 'AGENTS.override.md'), 'utf8'), /OVERTLI-TASK-MANAGER:BEGIN/);

  const explicit = installWorkspace({ workspaceRoot, packageRoot, targetAgentsFile: 'AGENTS.override.md', dryRun: false });
  const explicitAgents = explicit.results.find((item) => item.step === 'agents');
  assert.equal(explicitAgents.ok, true);
  assert.equal(explicitAgents.warning, undefined);
  assert.match(fs.readFileSync(path.join(workspaceRoot, 'AGENTS.override.md'), 'utf8'), /OVERTLI-TASK-MANAGER:BEGIN/);
});

test('global installer preserves unrelated hooks and installs discoverable skills', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-global-install-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-existing-hook' }] }] } }, null, 2)}\n`, 'utf8');

  const first = installGlobal({ codexHome, packageRoot });
  const second = installGlobal({ codexHome, packageRoot });
  assert.equal(first.ok, true);
  assert.equal(second.results.find((item) => item.step === 'hooks').action, 'unchanged');
  assert.equal(second.results.find((item) => item.step === 'skills').action, 'unchanged');

  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.Stop[0].hooks[0].command, 'keep-existing-hook');
  assert.equal(hooks.Stop.at(-1).hooks[0].command, `node "${path.join(packageRoot, 'bin', 'otm.mjs')}" hook stop`);
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'overtli-task-manager', 'SKILL.md')));
});

test('workspace discovery prefers the enclosing git root over nested package manifests', () => {
  const workspaceRoot = tempWorkspace('otm-root-detection-');
  const nestedRoot = path.join(workspaceRoot, 'packages', 'app');
  const nestedCwd = path.join(nestedRoot, 'src');
  fs.mkdirSync(nestedCwd, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), '# Root guidance\n', 'utf8');
  fs.writeFileSync(path.join(nestedRoot, 'package.json'), '{}\n', 'utf8');

  assert.equal(findWorkspaceRoot(nestedCwd), workspaceRoot);
});

test('session start creates and refreshes only the managed AGENTS.md block', async () => {
  const emptyWorkspace = tempWorkspace('otm-session-agents-create-');
  const env = testEnv('session-agents');
  const created = await withCapturedStdout(() => runHookScript('session-start', {
    cwd: emptyWorkspace,
    env,
    stdin: JSON.stringify({ cwd: emptyWorkspace, hook_event_name: 'SessionStart' })
  }));
  assert.match(fs.readFileSync(path.join(emptyWorkspace, 'AGENTS.md'), 'utf8'), /OVERTLI-TASK-MANAGER:BEGIN/);
  assert.match(created.result.systemMessage, /AGENTS\.md managed instructions: created/);

  const workspaceRoot = tempWorkspace('otm-session-agents-');
  const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
  fs.writeFileSync(agentsPath, '# Project guidance\n\nKeep this content.\n', 'utf8');

  const first = await withCapturedStdout(() => runHookScript('session-start', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'SessionStart' })
  }));
  const firstAgents = fs.readFileSync(agentsPath, 'utf8');
  assert.match(firstAgents, /Keep this content/);
  assert.equal((firstAgents.match(/OVERTLI-TASK-MANAGER:BEGIN/g) || []).length, 1);
  assert.match(first.result.systemMessage, /AGENTS\.md managed instructions: appended/);

  const outdated = firstAgents.replace('Prefer thorough completion over shallow progress.', 'Outdated managed instruction.');
  fs.writeFileSync(agentsPath, outdated, 'utf8');
  const second = await withCapturedStdout(() => runHookScript('session-start', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'SessionStart' })
  }));
  const refreshed = fs.readFileSync(agentsPath, 'utf8');
  assert.match(refreshed, /Prefer thorough completion over shallow progress/);
  assert.doesNotMatch(refreshed, /Outdated managed instruction/);
  assert.match(refreshed, /Keep this content/);
  assert.equal((refreshed.match(/OVERTLI-TASK-MANAGER:BEGIN/g) || []).length, 1);
  assert.match(second.result.systemMessage, /AGENTS\.md managed instructions: updated/);
});

test('project review scans memory-bank / memory_bank and indexes overview files', () => {
  const workspaceRoot = tempWorkspace('otm-review-');
  
  // Create a memory_bank folder with a markdown file
  const mbDir = path.join(workspaceRoot, 'memory_bank');
  fs.mkdirSync(mbDir, { recursive: true });
  fs.writeFileSync(path.join(mbDir, 'projectbrief.md'), '# Project Brief\n\nGoal: Build a cool task manager.\n', 'utf8');

  // Create a memory-bank folder with a markdown file
  const mbHyphenDir = path.join(workspaceRoot, 'memory-bank');
  fs.mkdirSync(mbHyphenDir, { recursive: true });
  fs.writeFileSync(path.join(mbHyphenDir, 'productContext.md'), '# Product Context\n\nPurpose: Codex route management.\n', 'utf8');

  const review = reviewProjectContext({ workspaceRoot });
  assert.equal(review.sourceCount, 3); // README.md (created by tempWorkspace) + projectbrief.md + productContext.md
  
  const briefSource = review.sources.find(s => s.path.replace(/\\/g, '/') === 'memory_bank/projectbrief.md');
  const contextSource = review.sources.find(s => s.path.replace(/\\/g, '/') === 'memory-bank/productContext.md');
  
  assert.ok(briefSource);
  assert.ok(contextSource);
  assert.match(review.summary, /memory_bank/);
  assert.match(review.summary, /memory-bank/);
});

test('project review reuses unchanged cache without rewriting files', () => {
  const workspaceRoot = tempWorkspace('otm-review-cache-');
  const first = reviewProjectContext({ workspaceRoot });
  const cacheRoot = path.join(workspaceRoot, '.codex', 'overtli-task-manager', 'cache');
  const jsonPath = path.join(cacheRoot, 'project-review.json');
  const mdPath = path.join(cacheRoot, 'project-review.md');
  const oldTime = new Date('2024-01-01T00:00:00.000Z');
  fs.utimesSync(jsonPath, oldTime, oldTime);
  fs.utimesSync(mdPath, oldTime, oldTime);
  fs.utimesSync(path.join(workspaceRoot, 'README.md'), new Date('2025-01-01T00:00:00.000Z'), new Date('2025-01-01T00:00:00.000Z'));

  const second = reviewProjectContext({ workspaceRoot });
  const jsonAfter = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(second.unchanged, true);
  assert.equal(second.cacheStatus, 'unchanged');
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(jsonAfter.createdAt, first.createdAt);
  assert.equal(fs.statSync(jsonPath).mtimeMs, oldTime.getTime());
  assert.equal(fs.statSync(mdPath).mtimeMs, oldTime.getTime());
});

test('stop hook requires model-visible finalization before clearing current state by default', async () => {
  const workspaceRoot = tempWorkspace('otm-stop-finalize-');
  const env = testEnv('otm-stop-finalize');
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Complete route',
    tasks: [{ title: 'Finish one task', internalSteps: ['Inspect', 'Validate'] }]
  });
  const taskId = started.snapshot.tasks[0].id;
  finishInternalSteps(manager, workspaceRoot, taskId);
  manager.completeTask({
    workspaceRoot,
    taskId,
    evidence: { kind: 'test_result', summary: 'Route task passed.' }
  });

  const blocked = await withCapturedStdout(() => runHookScript('stop', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'Stop', turn_id: 'turn-stop' })
  }));
  assert.equal(blocked.result.decision, 'block');
  assert.match(blocked.result.reason, /visible finalization must be model-driven/);
  assert.equal(manager.snapshot({ workspaceRoot, write: false }).run.status, 'active');

  manager.finalizeTurn({ workspaceRoot, outcome: 'completed' });
  manager.clearCurrent({ workspaceRoot });

  const allowed = await withCapturedStdout(() => runHookScript('stop', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'Stop', turn_id: 'turn-stop' })
  }));
  assert.equal(allowed.result.continue, true);
  assert.doesNotMatch(allowed.captured, /visible finalization must be model-driven/);
});
