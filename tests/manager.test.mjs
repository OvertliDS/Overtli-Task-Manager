import './support/temp-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTaskManager } from '../src/core/manager.mjs';
import { currentJsonPath, findWorkspaceRoot, workspaceScratchDir, workspaceTempDir } from '../src/core/fs-utils.mjs';
import { loadBetterSqlite3, SqliteStore, SQLITE_SCHEMA_VERSION } from '../src/storage/sqlite-store.mjs';
import { JsonStore } from '../src/storage/json-store.mjs';
import { installWorkspace } from '../src/install/install-workspace.mjs';
import { uninstallWorkspace } from '../src/install/uninstall-workspace.mjs';
import { installRepoSkills } from '../src/install/skill-install.mjs';
import { installGlobal } from '../src/install/install-global.mjs';
import { uninstallGlobal } from '../src/install/uninstall-global.mjs';
import { reviewProjectContext } from '../src/context/project-review.mjs';
import { runHookScript } from '../src/hooks/runner.mjs';
import { runPostinstall, shouldAutoInstallGlobal } from '../scripts/postinstall.mjs';
import { resolveSessionId } from '../src/core/session-scope.mjs';
import { handleCli } from '../src/cli/commands.mjs';

function tempWorkspace(prefix = 'otm-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Test Workspace\n', 'utf8');
  return root;
}

function testEnv(name) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-state-`));
  const env = { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: stateDir };
  delete env.CODEX_THREAD_ID;
  delete env.OTM_SESSION_ID;
  return env;
}

function sqliteTestEnv(name) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-sqlite-state-`));
  const env = { ...process.env, OTM_STORAGE: 'sqlite', OTM_STATE_DIR: stateDir };
  delete env.CODEX_THREAD_ID;
  delete env.OTM_SESSION_ID;
  return env;
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
  return (task.internalSteps || task.metadata?.internalSteps || []).map((step) => typeof step === 'string' ? step : step.title);
}

function internalStepStatuses(task) {
  return (task.internalSteps || task.metadata?.internalSteps || []).map((step) => typeof step === 'string' ? 'pending' : step.status);
}

function finishInternalSteps(manager, workspaceRoot, taskId, statusByTitle = {}) {
  const snapshot = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  const task = snapshot.tasks.find((item) => item.id === taskId);
  for (const step of task?.internalSteps || task?.metadata?.internalSteps || []) {
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

test('concurrent Codex sessions keep independent routes and current files in one workspace', () => {
  const workspaceRoot = tempWorkspace('otm-session-isolation-');
  const baseEnv = testEnv('otm-session-isolation');
  const sessionA = 'thread-session-a';
  const sessionB = 'thread-session-b';
  const managerA = createTaskManager({ cwd: workspaceRoot, env: { ...baseEnv, CODEX_THREAD_ID: sessionA } });
  const managerB = createTaskManager({ cwd: workspaceRoot, env: { ...baseEnv, CODEX_THREAD_ID: sessionB } });

  const startedA = managerA.start({ workspaceRoot, goal: 'Route A', tasks: [{ title: 'Task A' }] });
  const startedB = managerB.start({ workspaceRoot, replaceExisting: true, goal: 'Route B', tasks: [{ title: 'Task B' }] });

  assert.equal(managerA.store.getRun(startedA.run.id).status, 'active');
  assert.equal(managerB.store.getRun(startedB.run.id).status, 'active');
  assert.equal(managerA.snapshot({ workspaceRoot, write: false }).run.id, startedA.run.id);
  assert.equal(managerB.snapshot({ workspaceRoot, write: false }).run.id, startedB.run.id);
  assert.notEqual(startedA.snapshot.paths.currentJson, startedB.snapshot.paths.currentJson);
  assert.ok(fs.existsSync(path.join(workspaceRoot, startedA.snapshot.paths.currentJson)));
  assert.ok(fs.existsSync(path.join(workspaceRoot, startedB.snapshot.paths.currentJson)));

  const index = JSON.parse(fs.readFileSync(currentJsonPath(workspaceRoot), 'utf8'));
  assert.equal(index.schemaVersion, 'otm.current-index.v1');
  assert.equal(index.activeSessionCount, 2);
  assert.throws(
    () => managerA.snapshot({ workspaceRoot, runId: startedB.run.id, write: false }),
    /different Codex session/
  );

  const scratchA = workspaceScratchDir(workspaceRoot, sessionA);
  const scratchB = workspaceScratchDir(workspaceRoot, sessionB);
  fs.mkdirSync(scratchA, { recursive: true });
  fs.mkdirSync(scratchB, { recursive: true });
  fs.writeFileSync(path.join(scratchA, 'a.txt'), 'a', 'utf8');
  fs.writeFileSync(path.join(scratchB, 'b.txt'), 'b', 'utf8');
  assert.throws(() => managerA.clearCurrent({ workspaceRoot, runId: startedA.run.id }), { code: 'CLEAR_REQUIRES_FINALIZATION' });
  assert.equal(fs.existsSync(path.join(scratchA, 'a.txt')), true);
  assert.equal(fs.existsSync(path.join(scratchB, 'b.txt')), true);
  assert.equal(managerB.snapshot({ workspaceRoot, write: false }).run.id, startedB.run.id);
  assert.equal(JSON.parse(fs.readFileSync(currentJsonPath(workspaceRoot), 'utf8')).activeSessionCount, 2);
  managerA.abandonRun({ workspaceRoot, runId: startedA.run.id, reason: 'Explicit test abandonment' });
  assert.equal(fs.existsSync(path.join(scratchA, 'a.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(currentJsonPath(workspaceRoot), 'utf8')).activeSessionCount, 1);
});

test('separate OTM processes preserve JSON runs and the workspace session index', async () => {
  const workspaceRoot = tempWorkspace('otm-process-isolation-');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-process-state-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const script = `
    import { createTaskManager } from './src/core/manager.mjs';
    const workspaceRoot = process.env.OTM_TEST_WORKSPACE;
    const manager = createTaskManager({ cwd: workspaceRoot, env: process.env });
    manager.start({ workspaceRoot, goal: process.env.CODEX_THREAD_ID, tasks: [{ title: 'Concurrent child task' }] });
  `;
  const runChild = (sessionId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageRoot,
      env: { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: stateDir, OTM_TEST_WORKSPACE: workspaceRoot, CODEX_THREAD_ID: sessionId },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Child ${sessionId} exited ${code}: ${stderr}`)));
  });

  await Promise.all([runChild('process-session-a'), runChild('process-session-b')]);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'json', 'state.json'), 'utf8'));
  assert.equal(state.runs.length, 2);
  assert.deepEqual(new Set(state.runs.map((run) => run.sessionId)), new Set(['process-session-a', 'process-session-b']));
  const index = JSON.parse(fs.readFileSync(currentJsonPath(workspaceRoot), 'utf8'));
  assert.equal(index.activeSessionCount, 2);
  assert.equal(index.sessions.length, 2);
});

test('two simultaneous starts for one workspace and session create exactly one active route', async () => {
  const workspaceRoot = tempWorkspace('otm-process-single-scope-');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-process-single-scope-state-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const script = `
    import { createTaskManager } from './src/core/manager.mjs';
    const workspaceRoot = process.env.OTM_TEST_WORKSPACE;
    createTaskManager({ cwd: workspaceRoot, env: process.env }).start({ workspaceRoot, goal: 'Concurrent same scope', tasks: [{ title: 'One route only' }] });
  `;
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageRoot,
      env: { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: stateDir, OTM_TEST_WORKSPACE: workspaceRoot, CODEX_THREAD_ID: 'one-session' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Child exited ${code}: ${stderr}`)));
  });
  await Promise.all([runChild(), runChild()]);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'json', 'state.json'), 'utf8'));
  const active = state.runs.filter((run) => run.workspaceRoot === workspaceRoot && run.sessionId === 'one-session' && ['active', 'ready_to_finalize', 'blocked', 'paused'].includes(run.status));
  assert.equal(active.length, 1);
  assert.equal(state.runs.length, 1);
});

test('the same Codex session keeps routes independent across workspaces', () => {
  const workspaceA = tempWorkspace('otm-workspace-a-');
  const workspaceB = tempWorkspace('otm-workspace-b-');
  const env = { ...testEnv('otm-workspace-isolation'), CODEX_THREAD_ID: 'shared-thread' };
  const manager = createTaskManager({ cwd: workspaceA, env });
  const routeA = manager.start({ workspaceRoot: workspaceA, goal: 'Workspace A', tasks: [{ title: 'A' }] });
  const routeB = manager.start({ workspaceRoot: workspaceB, replaceExisting: true, goal: 'Workspace B', tasks: [{ title: 'B' }] });

  assert.equal(manager.store.getRun(routeA.run.id).status, 'active');
  assert.equal(manager.store.getRun(routeB.run.id).status, 'active');
  assert.equal(manager.snapshot({ workspaceRoot: workspaceA, write: false }).run.id, routeA.run.id);
  assert.equal(manager.snapshot({ workspaceRoot: workspaceB, write: false }).run.id, routeB.run.id);
});

test('legacy unscoped routes require explicit opt-in before a scoped session claims them', () => {
  const workspaceRoot = tempWorkspace('otm-legacy-claim-');
  const baseEnv = testEnv('otm-legacy-claim');
  delete baseEnv.CODEX_THREAD_ID;
  delete baseEnv.OTM_SESSION_ID;
  const legacyManager = createTaskManager({ cwd: workspaceRoot, env: baseEnv });
  const legacy = legacyManager.start({ workspaceRoot, goal: 'Legacy route', tasks: [{ title: 'Legacy task' }] });

  const managerA = createTaskManager({ cwd: workspaceRoot, env: { ...baseEnv, CODEX_THREAD_ID: 'claiming-thread' } });
  assert.equal(managerA.snapshot({ workspaceRoot, write: false }).run, null);
  assert.equal(managerA.store.getRun(legacy.run.id).sessionId, null);

  const claimingManager = createTaskManager({
    cwd: workspaceRoot,
    env: { ...baseEnv, CODEX_THREAD_ID: 'explicit-claiming-thread', OTM_CLAIM_LEGACY_ROUTE: '1' }
  });
  assert.equal(claimingManager.snapshot({ workspaceRoot, write: false }).run.id, legacy.run.id);
  assert.equal(claimingManager.store.getRun(legacy.run.id).sessionId, 'explicit-claiming-thread');
});

test('session identity resolves supported hook payload aliases before environment fallback', () => {
  assert.equal(resolveSessionId({ session_id: 'session-id' }, {}), 'session-id');
  assert.equal(resolveSessionId({ thread_id: 'thread-id' }, {}), 'thread-id');
  assert.equal(resolveSessionId({ conversationId: 'conversation-id' }, {}), 'conversation-id');
  assert.equal(resolveSessionId({}, { CODEX_THREAD_ID: 'environment-id' }), 'environment-id');
});

test('sqlite isolates multiple chats in one project and one chat across projects', () => {
  assert.ok(loadBetterSqlite3(), 'better-sqlite3 is required for the SQLite conformance lane');
  const workspaceA = tempWorkspace('otm-sqlite-matrix-a-');
  const workspaceB = tempWorkspace('otm-sqlite-matrix-b-');
  const baseEnv = sqliteTestEnv('otm-sqlite-matrix');
  const managerA1 = createTaskManager({ cwd: workspaceA, env: { ...baseEnv, CODEX_THREAD_ID: 'chat-a' } });
  const managerA2 = createTaskManager({ cwd: workspaceA, env: { ...baseEnv, CODEX_THREAD_ID: 'chat-b' } });
  const managerB1 = createTaskManager({ cwd: workspaceB, env: { ...baseEnv, CODEX_THREAD_ID: 'chat-a' } });
  const routeA1 = managerA1.start({ workspaceRoot: workspaceA, goal: 'A1', tasks: [{ title: 'A1' }] });
  const routeA2 = managerA2.start({ workspaceRoot: workspaceA, goal: 'A2', tasks: [{ title: 'A2' }] });
  const routeB1 = managerB1.start({ workspaceRoot: workspaceB, goal: 'B1', tasks: [{ title: 'B1' }] });

  assert.equal(managerA1.snapshot({ workspaceRoot: workspaceA, write: false }).run.id, routeA1.run.id);
  assert.equal(managerA2.snapshot({ workspaceRoot: workspaceA, write: false }).run.id, routeA2.run.id);
  assert.equal(managerB1.snapshot({ workspaceRoot: workspaceB, write: false }).run.id, routeB1.run.id);
  assert.equal(managerA1.store.listActiveRuns(workspaceA).length, 2);
  assert.equal(managerA1.store.listActiveRuns(workspaceB).length, 1);
});

test('unscoped snapshots preserve the workspace index when scoped routes are active', () => {
  const workspaceRoot = tempWorkspace('otm-index-preserve-');
  const baseEnv = testEnv('otm-index-preserve');
  const managerA = createTaskManager({ cwd: workspaceRoot, env: { ...baseEnv, CODEX_THREAD_ID: 'index-a' } });
  const managerB = createTaskManager({ cwd: workspaceRoot, env: { ...baseEnv, CODEX_THREAD_ID: 'index-b' } });
  managerA.start({ workspaceRoot, goal: 'Index A', tasks: [{ title: 'A' }] });
  managerB.start({ workspaceRoot, goal: 'Index B', tasks: [{ title: 'B' }] });

  const unscoped = createTaskManager({ cwd: workspaceRoot, env: baseEnv });
  assert.equal(unscoped.snapshot({ workspaceRoot }).run, null);
  const index = JSON.parse(fs.readFileSync(currentJsonPath(workspaceRoot), 'utf8'));
  assert.equal(index.schemaVersion, 'otm.current-index.v1');
  assert.equal(index.activeSessionCount, 2);
  assert.throws(
    () => unscoped.start({ workspaceRoot, goal: 'Ambiguous route', tasks: [{ title: 'Unsafe' }] }),
    /session id is required/
  );
});

test('scoped state writes do not prune another session scratch evidence', () => {
  const workspaceRoot = tempWorkspace('otm-scratch-isolation-');
  const baseEnv = testEnv('otm-scratch-isolation');
  const managerA = createTaskManager({ cwd: workspaceRoot, env: { ...baseEnv, CODEX_THREAD_ID: 'scratch-a' } });
  const managerB = createTaskManager({ cwd: workspaceRoot, env: { ...baseEnv, CODEX_THREAD_ID: 'scratch-b' } });
  const routeA = managerA.start({ workspaceRoot, goal: 'Scratch A', tasks: [{ title: 'A' }] });
  managerB.start({ workspaceRoot, goal: 'Scratch B', tasks: [{ title: 'B' }] });
  const scratchB = workspaceScratchDir(workspaceRoot, 'scratch-b');
  fs.mkdirSync(scratchB, { recursive: true });
  const evidencePath = path.join(scratchB, 'old-but-active.txt');
  fs.writeFileSync(evidencePath, 'preserve', 'utf8');
  const oldTime = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(evidencePath, oldTime, oldTime);

  managerA.progress({ workspaceRoot, taskId: routeA.snapshot.tasks[0].id, message: 'Write A state.' });
  assert.equal(fs.existsSync(evidencePath), true);
  createTaskManager({ cwd: workspaceRoot, env: baseEnv }).clearCurrent({ workspaceRoot });
  assert.equal(fs.existsSync(evidencePath), true);
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

test('unchanged writable snapshots do not churn the workspace session index', async () => {
  const workspaceRoot = tempWorkspace('otm-index-noop-');
  const env = { ...testEnv('otm-index-noop'), CODEX_THREAD_ID: 'index-noop' };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  manager.start({ workspaceRoot, goal: 'Index no-op', tasks: [{ title: 'Stable index' }] });
  const indexPath = path.join(workspaceRoot, '.codex', 'overtli-task-manager', 'current.json');
  const before = fs.statSync(indexPath).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  manager.snapshot({ workspaceRoot });
  assert.equal(fs.statSync(indexPath).mtimeMs, before);
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

test('default cleanup preserves active-session scratch and allSessions cleanup is explicit', () => {
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

  const preview = manager.cleanupWorkspace({ workspaceRoot, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.removed.length, 1);
  assert.equal(fs.existsSync(tempFile), true, 'cleanup dry run must preserve candidate files');
  const result = manager.cleanupWorkspace({ workspaceRoot });

  assert.equal(fs.existsSync(tempFile), false);
  assert.equal(fs.existsSync(scratchFile), true);
  assert.equal(fs.existsSync(keepFile), true);
  assert.equal(result.removed.length, 1);
  assert.match(result.markdown, /Active-session scratch skipped: 1/);
  assert.throws(() => manager.cleanupWorkspace({ workspaceRoot, allSessions: true, scratchMaxAgeMs: 0 }), { code: 'CLEANUP_CONFIRMATION_REQUIRED' });
  const forced = manager.cleanupWorkspace({ workspaceRoot, allSessions: true, confirm: true, scratchMaxAgeMs: 0 });
  assert.equal(fs.existsSync(scratchFile), false);
  assert.equal(forced.removed.length, 1);
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

test('sqlite history pruning removes old inactive rows', () => {
  assert.ok(loadBetterSqlite3(), 'better-sqlite3 is required for the SQLite conformance lane');
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
  const env = { ...testEnv('otm-scratchpad'), CODEX_THREAD_ID: 'scratchpad-session' };
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
      session_id: 'scratchpad-session',
      invocation_id: 'scratchpad-tool',
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
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0].acceptanceCriteria, ['Render policy is stable']);
  assert.deepEqual(tasks[1].acceptanceCriteria, ['Compact progress stays fast']);

  manager.reconcile({
    workspaceRoot,
    tasks: [{ title: 'Update install docs', required: true, acceptanceCriteria: ['README is current'] }]
  });
  tasks = manager.snapshot({ workspaceRoot, write: false }).snapshot.tasks;
  assert.equal(tasks.length, 3);
  assert.equal(tasks[2].title, 'Update install docs');
  assert.match(manager.snapshot({ workspaceRoot, write: false }).markdown, /Profile current render path/);
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
  assert.deepEqual(reopened.internalSteps.map((step) => step.status), ['active']);
  assert.equal(reopened.metadata.reopened.at(-1).previousStatus, 'done');
  assert.equal(manager.auditStop({ workspaceRoot }).stopAllowed, false);
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
  assert.deepEqual(task.internalSteps.map((step) => step.status), ['done', 'active', 'pending']);
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
  assert.deepEqual(completedTask.internalSteps.map((step) => step.status), ['done', 'done', 'done']);
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

test('skill installer manages every packaged file in a skill directory', () => {
  const workspaceRoot = tempWorkspace('otm-skill-tree-');
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-skill-package-'));
  const sourceSkill = path.join(packageRoot, 'skills', 'example-skill');
  fs.mkdirSync(path.join(sourceSkill, 'references'), { recursive: true });
  fs.writeFileSync(path.join(sourceSkill, 'SKILL.md'), '# Example\n', 'utf8');
  fs.writeFileSync(path.join(sourceSkill, 'references', 'guide.md'), 'Reference\n', 'utf8');
  const result = installRepoSkills({ workspaceRoot, packageRoot });
  const installed = result.installed[0];
  assert.equal(installed.files.length, 2);
  assert.equal(fs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'example-skill', 'references', 'guide.md'), 'utf8'), 'Reference\n');
});

test('workspace uninstall is previewable, confirmation-gated, and preserves unrelated configuration', () => {
  const workspaceRoot = tempWorkspace('otm-uninstall-');
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), '# Existing guidance\nKeep this text.\n', 'utf8');
  fs.mkdirSync(path.join(workspaceRoot, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, '.codex', 'hooks.json'), `${JSON.stringify({ hooks: { Stop: [{ matcher: 'keep', hooks: [{ type: 'command', command: 'keep-existing-hook' }] }] } }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, '.codex', 'config.toml'), '# existing config\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, '.gitignore'), 'node_modules/\n', 'utf8');
  assert.equal(installWorkspace({ workspaceRoot, packageRoot, installMcpConfig: true }).ok, true);
  const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
  const beforePreview = fs.readFileSync(agentsPath, 'utf8');
  const preview = uninstallWorkspace({ workspaceRoot, packageRoot, dryRun: true });
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, true);
  assert.equal(fs.readFileSync(agentsPath, 'utf8'), beforePreview);
  const notConfirmed = uninstallWorkspace({ workspaceRoot, packageRoot });
  assert.equal(notConfirmed.ok, false);
  assert.equal(notConfirmed.results[0].action, 'confirmation-required');
  const result = uninstallWorkspace({ workspaceRoot, packageRoot, confirm: true });
  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(agentsPath, 'utf8'), /Keep this text/);
  assert.doesNotMatch(fs.readFileSync(agentsPath, 'utf8'), /OVERTLI-TASK-MANAGER:BEGIN/);
  assert.equal(fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf8').trim(), 'node_modules/');
  assert.match(fs.readFileSync(path.join(workspaceRoot, '.codex', 'config.toml'), 'utf8'), /existing config/);
  assert.doesNotMatch(fs.readFileSync(path.join(workspaceRoot, '.codex', 'config.toml'), 'utf8'), /OVERTLI-TASK-MANAGER:MCP:BEGIN/);
  const hooks = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.codex', 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.Stop.length, 1);
  assert.equal(hooks.Stop[0].hooks[0].command, 'keep-existing-hook');
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.agents', 'skills', 'overtli-task-manager')), false);
  assert.ok(fs.existsSync(path.join(result.backupPath, 'manifest.json')));
});

test('workspace uninstall preserves user-modified managed skill directories', () => {
  const workspaceRoot = tempWorkspace('otm-uninstall-skill-ownership-');
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(installWorkspace({ workspaceRoot, packageRoot }).ok, true);
  const skillDir = path.join(workspaceRoot, '.agents', 'skills', 'overtli-task-manager');
  fs.writeFileSync(path.join(skillDir, 'local-notes.md'), 'do not remove\n', 'utf8');
  const result = uninstallWorkspace({ workspaceRoot, packageRoot, confirm: true });
  assert.equal(result.ok, true);
  const skillResult = result.results.find((item) => item.step === 'skills');
  assert.equal(skillResult.installed.find((item) => item.name === 'overtli-task-manager').action, 'skipped-ownership-mismatch');
  assert.equal(fs.readFileSync(path.join(skillDir, 'local-notes.md'), 'utf8'), 'do not remove\n');
});

test('workspace uninstall preflight blocks all writes for malformed hooks and state removal keeps recovery data', () => {
  const workspaceRoot = tempWorkspace('otm-uninstall-preflight-');
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(installWorkspace({ workspaceRoot, packageRoot }).ok, true);
  const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
  const installedAgents = fs.readFileSync(agentsPath, 'utf8');
  const hooksPath = path.join(workspaceRoot, '.codex', 'hooks.json');
  fs.writeFileSync(hooksPath, '{broken', 'utf8');
  const blocked = uninstallWorkspace({ workspaceRoot, packageRoot, confirm: true });
  assert.equal(blocked.ok, false);
  assert.equal(fs.readFileSync(agentsPath, 'utf8'), installedAgents);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), '{broken');

  // Restore valid hooks, then verify state removal does not erase its own
  // rollback material. Active snapshots are a separate hard stop; an
  // administrative state delete cannot silently discard live route evidence.
  fs.writeFileSync(hooksPath, JSON.stringify({ hooks: {} }, null, 2), 'utf8');
  const activeCurrent = path.join(workspaceRoot, '.codex', 'overtli-task-manager', 'current.json');
  fs.writeFileSync(activeCurrent, JSON.stringify({ status: 'active' }), 'utf8');
  const activeBlocked = uninstallWorkspace({ workspaceRoot, packageRoot, confirm: true, removeState: true });
  assert.equal(activeBlocked.ok, false);
  assert.equal(activeBlocked.results.find((item) => item.step === 'state').action, 'active-state');
  fs.writeFileSync(activeCurrent, JSON.stringify({ status: 'cleared' }), 'utf8');
  const removed = uninstallWorkspace({ workspaceRoot, packageRoot, confirm: true, removeState: true });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.codex', 'overtli-task-manager')), false);
  assert.ok(fs.existsSync(path.join(workspaceRoot, '.codex', 'overtli-task-manager-backups', path.basename(removed.backupPath), 'uninstall.json')));
});

test('global installer preserves unrelated hooks and installs discoverable skills', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-global-install-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-existing-hook' }] }] } }, null, 2)}\n`, 'utf8');

  const first = installGlobal({ codexHome, packageRoot, now: () => new Date('2026-07-04T12:00:00.000Z') });
  const second = installGlobal({ codexHome, packageRoot });
  assert.equal(first.ok, true);
  assert.equal(first.backupPath, path.join(codexHome, 'hooks.json.before-otm-global-2026-07-04T12-00-00-000Z.bak'));
  assert.ok(fs.existsSync(first.backupPath));
  assert.ok(fs.existsSync(path.join(first.transactionBackupPath, 'install.json')));
  assert.equal(second.results.find((item) => item.step === 'hooks').action, 'unchanged');
  assert.equal(second.results.find((item) => item.step === 'skills').action, 'unchanged');

  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.Stop[0].hooks[0].command, 'keep-existing-hook');
  assert.equal(hooks.Stop.at(-1).hooks[0].command, `node "${path.join(packageRoot, 'bin', 'otm.mjs')}" hook stop`);
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'overtli-task-manager', 'SKILL.md')));
});

test('global uninstall is previewable, confirmation-gated, and preserves unrelated hooks', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-global-uninstall-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const hooksPath = path.join(codexHome, 'hooks.json');
  fs.writeFileSync(hooksPath, `${JSON.stringify({ hooks: { Stop: [{ matcher: 'keep', hooks: [{ type: 'command', command: 'keep-existing-hook' }] }] } }, null, 2)}\n`, 'utf8');
  assert.equal(installGlobal({ codexHome, packageRoot }).ok, true);
  const beforePreview = fs.readFileSync(hooksPath, 'utf8');
  const preview = uninstallGlobal({ codexHome, packageRoot, dryRun: true });
  assert.equal(preview.ok, true);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), beforePreview);
  assert.equal(uninstallGlobal({ codexHome, packageRoot }).results[0].action, 'confirmation-required');
  const result = uninstallGlobal({ codexHome, packageRoot, confirm: true });
  assert.equal(result.ok, true);
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks;
  assert.equal(hooks.Stop.length, 1);
  assert.equal(hooks.Stop[0].hooks[0].command, 'keep-existing-hook');
  assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'overtli-task-manager')), false);
  assert.ok(fs.existsSync(path.join(result.backupPath, 'manifest.json')));
});

test('global uninstall preserves modified skills and malformed hooks block all writes', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-global-uninstall-safety-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(installGlobal({ codexHome, packageRoot }).ok, true);
  const skillDir = path.join(codexHome, 'skills', 'overtli-task-manager');
  fs.writeFileSync(path.join(skillDir, 'local.md'), 'retain\n', 'utf8');
  const preserved = uninstallGlobal({ codexHome, packageRoot, confirm: true });
  assert.equal(preserved.results.find((item) => item.step === 'skills').installed.find((item) => item.name === 'overtli-task-manager').action, 'skipped-ownership-mismatch');
  assert.equal(fs.readFileSync(path.join(skillDir, 'local.md'), 'utf8'), 'retain\n');

  const blockedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-global-uninstall-invalid-'));
  assert.equal(installGlobal({ codexHome: blockedHome, packageRoot }).ok, true);
  const blockedHooks = path.join(blockedHome, 'hooks.json');
  fs.writeFileSync(blockedHooks, '{broken', 'utf8');
  const blocked = uninstallGlobal({ codexHome: blockedHome, packageRoot, confirm: true });
  assert.equal(blocked.ok, false);
  assert.equal(fs.existsSync(path.join(blockedHome, 'skills', 'overtli-task-manager')), true);
  assert.equal(fs.readFileSync(blockedHooks, 'utf8'), '{broken');
});

test('global installer preflight blocks every write when hooks configuration is malformed', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-global-preflight-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), '{broken', 'utf8');
  const result = installGlobal({ codexHome, packageRoot });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(codexHome, 'skills')), false);
});

test('a late global skill installation failure restores the earlier hooks change', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-global-rollback-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const hooksPath = path.join(codexHome, 'hooks.json');
  const originalHooks = '{\n  "hooks": {}\n}\n';
  fs.writeFileSync(hooksPath, originalHooks, 'utf8');
  // A regular file at the skills root passes the read-only preview but fails
  // when the live skill writer creates its child directory.
  fs.writeFileSync(path.join(codexHome, 'skills'), 'not a directory', 'utf8');
  const result = installGlobal({ codexHome, packageRoot });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), originalHooks);
  assert.equal(fs.readFileSync(path.join(codexHome, 'skills'), 'utf8'), 'not a directory');
});

test('postinstall never mutates global Codex state without explicit opt-in', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-postinstall-home-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const activePluginRoot = path.join(codexHome, 'plugins', 'overtli-task-manager');
  assert.equal(shouldAutoInstallGlobal({ packageRoot: activePluginRoot, codexHome, env: {} }), false);
  assert.equal(shouldAutoInstallGlobal({ packageRoot, codexHome, env: {} }), false);
  assert.equal(shouldAutoInstallGlobal({ packageRoot: activePluginRoot, codexHome, env: { CI: '1' } }), false);
  assert.equal(shouldAutoInstallGlobal({ packageRoot: activePluginRoot, codexHome, env: {} }), false);
  assert.equal(shouldAutoInstallGlobal({ packageRoot, codexHome, env: { OTM_AUTO_INSTALL_GLOBAL: '1' } }), true);
  assert.equal(shouldAutoInstallGlobal({ packageRoot: activePluginRoot, codexHome, env: { OTM_AUTO_INSTALL_GLOBAL: '0' } }), false);

  const skipped = runPostinstall({ packageRoot, env: { CODEX_HOME: codexHome } });
  assert.equal(skipped.installed, false);
  assert.equal(fs.existsSync(path.join(codexHome, 'hooks.json')), false);

  const installed = runPostinstall({ packageRoot, env: { CODEX_HOME: codexHome, OTM_AUTO_INSTALL_GLOBAL: '1' } });
  assert.equal(installed.installed, true);
  assert.ok(fs.existsSync(path.join(codexHome, 'hooks.json')));
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
  const env = { ...testEnv('session-agents'), OTM_AUTO_SYNC_AGENTS: '1', OTM_TRUSTED_INSTALLATION: '1' };
  const created = await withCapturedStdout(() => runHookScript('session-start', {
    cwd: emptyWorkspace,
    env,
    stdin: JSON.stringify({ cwd: emptyWorkspace, hook_event_name: 'SessionStart', invocation_id: 'agents-create' })
  }));
  assert.match(fs.readFileSync(path.join(emptyWorkspace, 'AGENTS.md'), 'utf8'), /OVERTLI-TASK-MANAGER:BEGIN/);
  assert.match(created.result.systemMessage, /AGENTS\.md managed instructions: created/);

  const workspaceRoot = tempWorkspace('otm-session-agents-');
  const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
  fs.writeFileSync(agentsPath, '# Project guidance\n\nKeep this content.\n', 'utf8');

  const first = await withCapturedStdout(() => runHookScript('session-start', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'SessionStart', invocation_id: 'agents-first' })
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
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'SessionStart', invocation_id: 'agents-second' })
  }));
  const refreshed = fs.readFileSync(agentsPath, 'utf8');
  assert.match(refreshed, /Prefer thorough completion over shallow progress/);
  assert.doesNotMatch(refreshed, /Outdated managed instruction/);
  assert.match(refreshed, /Keep this content/);
  assert.equal((refreshed.match(/OVERTLI-TASK-MANAGER:BEGIN/g) || []).length, 1);
  assert.match(second.result.systemMessage, /AGENTS\.md managed instructions: updated/);
});

test('session start never creates or mutates AGENTS.md without explicit trusted synchronization', async () => {
  const emptyWorkspace = tempWorkspace('otm-session-agents-default-disabled-');
  const env = testEnv('session-agents-default-disabled');
  const emptyResult = await withCapturedStdout(() => runHookScript('session-start', {
    cwd: emptyWorkspace,
    env,
    stdin: JSON.stringify({ cwd: emptyWorkspace, hook_event_name: 'SessionStart', invocation_id: 'agents-default-empty' })
  }));
  assert.equal(fs.existsSync(path.join(emptyWorkspace, 'AGENTS.md')), false);
  assert.match(emptyResult.result.systemMessage, /AGENTS\.md managed instructions: disabled/);

  const workspaceRoot = tempWorkspace('otm-session-agents-untrusted-');
  const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
  const original = '# Existing guidance\n\nDo not change this file.\n';
  fs.writeFileSync(agentsPath, original, 'utf8');
  const untrusted = await withCapturedStdout(() => runHookScript('session-start', {
    cwd: workspaceRoot,
    env: { ...testEnv('session-agents-untrusted'), OTM_AUTO_SYNC_AGENTS: '1' },
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'SessionStart', invocation_id: 'agents-untrusted' })
  }));
  assert.equal(fs.readFileSync(agentsPath, 'utf8'), original);
  assert.match(untrusted.result.systemMessage, /OTM_TRUSTED_INSTALLATION=1 is required/);
});

test('session-start hook surfaces project-review diagnostics without blocking the session', async () => {
  const workspaceRoot = tempWorkspace('otm-hook-review-diagnostic-');
  const env = { ...testEnv('otm-hook-review-diagnostic'), CODEX_THREAD_ID: 'review-diagnostic', OTM_PROJECT_REVIEW_MAX_FILES: '0', OTM_AUTO_SYNC_AGENTS: '0' };
  const result = await withCapturedStdout(() => runHookScript('session-start', { cwd: workspaceRoot, env, stdin: JSON.stringify({ cwd: workspaceRoot, session_id: 'review-diagnostic' }) }));
  assert.equal(result.result.continue, true);
  assert.match(result.result.systemMessage, /Project-review diagnostic:.*maxFiles/i);
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

test('project review counts only eligible files, reports limits, and cannot follow an external symlink', () => {
  const workspaceRoot = tempWorkspace('otm-review-safety-');
  const docs = path.join(workspaceRoot, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  for (let index = 1; index <= 4; index += 1) fs.writeFileSync(path.join(docs, `guide-${index}.md`), `# Guide ${index}\n\nSafe content ${index}.\n`, 'utf8');
  fs.writeFileSync(path.join(docs, 'binary.txt'), Buffer.from([0, 1, 2, 3]));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-review-external-'));
  fs.writeFileSync(path.join(external, 'secret.md'), '# Outside\n\nMUST_NOT_APPEAR\n', 'utf8');
  fs.symlinkSync(external, path.join(docs, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const limited = reviewProjectContext({ workspaceRoot, maxFiles: 2 });
  assert.equal(limited.diagnostics.candidateCount >= 5, true);
  assert.equal(limited.sourceCount <= 2, true);
  assert.equal(limited.diagnostics.limitsOmittedFiles, true);
  const broad = reviewProjectContext({ workspaceRoot, maxFiles: 20 });
  assert.equal(broad.diagnostics.skipped.binary, 1);
  assert.doesNotMatch(broad.summary, /MUST_NOT_APPEAR/);
});

test('stop hook requires model-visible finalization before clearing current state by default', async () => {
  const workspaceRoot = tempWorkspace('otm-stop-finalize-');
  const env = { ...testEnv('otm-stop-finalize'), CODEX_THREAD_ID: 'stop-finalize-session' };
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
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'Stop', turn_id: 'turn-stop', session_id: 'stop-finalize-session' })
  }));
  assert.equal(blocked.result.decision, 'block');
  assert.match(blocked.result.reason, /visible finalization must be model-driven/);
  assert.equal(manager.snapshot({ workspaceRoot, write: false }).run.status, 'ready_to_finalize');

  manager.finalizeTurn({ workspaceRoot, outcome: 'completed' });
  manager.clearCurrent({ workspaceRoot });

  const allowed = await withCapturedStdout(() => runHookScript('stop', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'Stop', turn_id: 'turn-stop', session_id: 'stop-finalize-session' })
  }));
  assert.equal(allowed.result.continue, true);
  assert.doesNotMatch(allowed.captured, /visible finalization must be model-driven/);
});

test('separate finalize and clear recover the completed scoped run and mark its summary cleared', () => {
  const workspaceRoot = tempWorkspace('otm-finalize-clear-state-');
  const env = { ...testEnv('otm-finalize-clear-state'), CODEX_THREAD_ID: 'finalize-clear-session' };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const started = manager.start({ workspaceRoot, goal: 'Finalize then clear', tasks: [{ title: 'Finish' }] });
  const taskId = started.snapshot.tasks[0].id;
  finishInternalSteps(manager, workspaceRoot, taskId);
  manager.completeTask({ workspaceRoot, taskId, evidence: { kind: 'test_result', summary: 'Complete.' } });

  const finalized = manager.finalizeTurn({ workspaceRoot, outcome: 'completed' });
  assert.equal(manager.store.getRun(started.run.id).status, 'completed');
  assert.equal(finalized.summary.currentCleared, false);
  manager.clearCurrent({ workspaceRoot });

  assert.equal(manager.store.getRun(started.run.id).status, 'cleared');
  assert.equal(manager.store.listSummaries(workspaceRoot).find((item) => item.runId === started.run.id).currentCleared, true);
});

test('finalization retries reuse one deterministic summary and memory record', () => {
  const workspaceRoot = tempWorkspace('otm-finalize-retry-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-finalize-retry') });
  const started = manager.start({ workspaceRoot, goal: 'Retry finalization', tasks: [{ title: 'Complete task' }] });
  finishInternalSteps(manager, workspaceRoot, started.snapshot.tasks[0].id);
  manager.completeTask({ workspaceRoot, taskId: started.snapshot.tasks[0].id, evidence: { kind: 'test_result', summary: 'Passed.' } });
  const first = manager.finalizeTurn({ workspaceRoot, operationId: 'finalize-once' });
  const second = manager.finalizeTurn({ workspaceRoot, runId: first.run.id, operationId: 'finalize-once' });
  assert.equal(second.idempotent, true);
  assert.equal(second.summary.id, first.summary.id);
  assert.equal(manager.store.listSummaries(workspaceRoot, 20).filter((summary) => summary.runId === first.run.id).length, 1);
  assert.equal(manager.store.listCache(workspaceRoot, 100).filter((entry) => entry.kind === 'turn_summary').length, 1);
});

test('repair republishs missing summary files from durable summary records', () => {
  const workspaceRoot = tempWorkspace('otm-summary-repair-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-summary-repair') });
  const started = manager.start({ workspaceRoot, goal: 'Repair summary', tasks: [{ title: 'Complete task' }] });
  finishInternalSteps(manager, workspaceRoot, started.snapshot.tasks[0].id);
  manager.completeTask({ workspaceRoot, taskId: started.snapshot.tasks[0].id, evidence: { kind: 'test_result', summary: 'Passed.' } });
  const finalized = manager.finalizeTurn({ workspaceRoot, operationId: 'repair-summary' });
  const files = fs.readdirSync(path.join(workspaceRoot, '.codex', 'overtli-task-manager', 'summaries'));
  for (const file of files) fs.rmSync(path.join(workspaceRoot, '.codex', 'overtli-task-manager', 'summaries', file));
  assert.equal(manager.repairSummaries({ workspaceRoot, dryRun: true }).repaired, 0);
  assert.equal(manager.repairSummaries({ workspaceRoot }).repaired, 1);
  assert.equal(fs.readdirSync(path.join(workspaceRoot, '.codex', 'overtli-task-manager', 'summaries')).length, 2);
  assert.ok(finalized.summary.id);
});

test('incomplete finalization requires and records an explicit reason', () => {
  const workspaceRoot = tempWorkspace('otm-incomplete-finalize-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-incomplete-finalize') });
  const started = manager.start({ workspaceRoot, goal: 'Incomplete checkpoint', tasks: [{ title: 'Unfinished task' }] });
  assert.throws(() => manager.finalizeTurn({ workspaceRoot, runId: started.run.id, allowIncomplete: true }), { code: 'INCOMPLETE_FINALIZATION_REASON_REQUIRED' });
  const finalized = manager.finalizeTurn({ workspaceRoot, runId: started.run.id, allowIncomplete: true, reason: 'Waiting for external access.' });
  assert.equal(finalized.run.status, 'blocked');
  assert.equal(finalized.run.metadata.incompleteFinalizationReason, 'Waiting for external access.');
});

test('blocked routes resume through an explicit transition and finalized routes archive idempotently', () => {
  const workspaceRoot = tempWorkspace('otm-resume-archive-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-resume-archive') });
  const started = manager.start({ workspaceRoot, goal: 'Resume then archive', tasks: [{ title: 'Recover task' }] });
  const taskId = started.snapshot.tasks[0].id;
  const blocked = manager.blockTask({ workspaceRoot, taskId, reason: 'Waiting for a dependency' });
  assert.equal(blocked.run.status, 'blocked');
  const resumed = manager.resumeRun({ workspaceRoot, runId: blocked.run.id, reason: 'Dependency available' });
  assert.equal(resumed.run.status, 'active');
  assert.equal(manager.store.getTask(taskId).status, 'active');
  assert.match(JSON.stringify(manager.store.getTask(taskId).evidence), /Waiting for a dependency/);
  for (const step of manager.store.getTask(taskId).metadata.internalSteps) {
    manager.progress({ workspaceRoot, taskId, internalStepId: step.id, evidence: { kind: 'manual_note', summary: step.title } });
  }
  manager.completeTask({ workspaceRoot, taskId, evidence: { kind: 'test_result', summary: 'Recovered and verified' } });
  const finalized = manager.finalizeTurn({ workspaceRoot, operationId: 'archive-route' });
  const archived = manager.archiveRun({ workspaceRoot, runId: finalized.run.id, reason: 'Retain as history' });
  assert.equal(archived.run.status, 'archived');
  assert.equal(manager.archiveRun({ workspaceRoot, runId: finalized.run.id }).idempotent, true);
  assert.throws(() => manager.resumeRun({ workspaceRoot, runId: finalized.run.id }), { code: 'INVALID_TRANSITION' });
});

test('identity-less hooks cannot read or mutate legacy route state', async () => {
  const workspaceRoot = tempWorkspace('otm-unscoped-hooks-');
  const env = testEnv('otm-unscoped-hooks');
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const legacy = manager.start({ workspaceRoot, goal: 'Legacy private route', tasks: [{ title: 'Do not expose this task' }] });
  const before = manager.store.getEvents(legacy.run.id).length;

  const sessionStart = await withCapturedStdout(() => runHookScript('session-start', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'SessionStart', invocation_id: 'unscoped-start' })
  }));
  const postTool = await withCapturedStdout(() => runHookScript('post-tool-use', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'PostToolUse', invocation_id: 'unscoped-tool', tool_name: 'Bash', tool_response: { exit_code: 1 } })
  }));
  const stop = await withCapturedStdout(() => runHookScript('stop', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'Stop', invocation_id: 'unscoped-stop' })
  }));

  assert.doesNotMatch(sessionStart.captured, /Legacy private route|Do not expose this task/);
  assert.equal(postTool.result.continue, true);
  assert.equal(stop.result.continue, true);
  assert.equal(manager.store.getEvents(legacy.run.id).length, before);
  assert.equal(manager.store.getRun(legacy.run.id).status, 'active');
});

test('separate global and workspace hook processes claim one shared invocation', async () => {
  const workspaceRoot = tempWorkspace('otm-hook-process-dedupe-');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-hook-process-state-'));
  const cliPath = fileURLToPath(new URL('../bin/otm.mjs', import.meta.url));
  const input = JSON.stringify({ cwd: workspaceRoot, hook_event_name: 'UserPromptSubmit', turn_id: 'process-dedupe-turn', session_id: 'process-dedupe-session', prompt: 'Implement a substantial feature.' });
  const runHook = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'hook', 'user-prompt-submit'], {
      cwd: workspaceRoot,
      env: { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: stateDir, CODEX_THREAD_ID: 'process-dedupe-session' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(`Hook exited ${code}: ${stderr}`)));
    child.stdin.end(input);
  });

  const outputs = await Promise.all([runHook(), runHook()]);
  assert.equal(outputs.filter((item) => item.hookSpecificOutput?.additionalContext).length, 1);
  assert.equal(outputs.filter((item) => item.continue === true && !item.hookSpecificOutput).length, 1);
});

test('reconciliation cannot drop or supersede a task from another run', () => {
  const workspaceRoot = tempWorkspace('otm-cross-run-reconcile-');
  const env = testEnv('otm-cross-run-reconcile');
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const first = manager.start({ workspaceRoot, sessionId: 'one', goal: 'First', tasks: [{ title: 'First task' }] });
  const second = manager.start({ workspaceRoot, sessionId: 'two', goal: 'Second', tasks: [{ title: 'Second task' }] });
  const firstTaskId = first.snapshot.tasks[0].id;
  assert.throws(() => manager.reconcile({ workspaceRoot, sessionId: 'two', runId: second.run.id, changes: [{ action: 'supersede', taskId: firstTaskId, reason: 'Bad scope' }] }), { code: 'TASK_RUN_SCOPE_MISMATCH' });
  assert.equal(manager.store.getTask(firstTaskId).status, 'active');
});

test('reconciliation rejects terminal task input and does not fuzzy-merge distinct tasks', () => {
  const workspaceRoot = tempWorkspace('otm-reconcile-input-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-reconcile-input') });
  const started = manager.start({ workspaceRoot, goal: 'Reconcile input', tasks: [{ title: 'Review API error contract' }] });
  assert.throws(() => manager.reconcile({ workspaceRoot, runId: started.run.id, tasks: [{ title: 'Review API error contract carefully', status: 'done' }] }), { code: 'INVALID_INITIAL_TASK_STATUS' });
  const result = manager.reconcile({ workspaceRoot, runId: started.run.id, tasks: [{ title: 'Review API error contract carefully' }] });
  assert.equal(result.run.id, started.run.id);
  assert.equal(manager.store.getTasks(started.run.id).length, 2);
});

test('reconciliation commits replacements and additions through one revisioned mutation', () => {
  for (const env of [testEnv('otm-reconcile-atomic-json'), sqliteTestEnv('otm-reconcile-atomic-sqlite')]) {
    const workspaceRoot = tempWorkspace('otm-reconcile-atomic-');
    const manager = createTaskManager({ cwd: workspaceRoot, env });
    const started = manager.start({ workspaceRoot, goal: 'Atomically reconcile', tasks: [{ id: 'first', title: 'First task' }, { id: 'second', title: 'Second task' }] });
    const result = manager.reconcile({
      workspaceRoot,
      expectedRevision: started.run.routeRevision,
      mode: 'replace',
      tasks: [{ id: 'replacement', title: 'Replacement task' }],
      operationId: 'atomic-reconcile-operation'
    });
    const tasks = manager.store.getTasks(result.run.id);
    assert.equal(result.run.routeRevision, started.run.routeRevision + 1);
    assert.equal(tasks.find((task) => task.id === 'first').status, 'superseded');
    assert.equal(tasks.find((task) => task.id === 'second').status, 'superseded');
    assert.equal(tasks.find((task) => task.id === 'replacement').status, 'active');
    assert.equal(manager.store.getEvents(result.run.id, 100).filter((event) => event.eventType === 'run_reconciled' && event.idempotencyKey === 'atomic-reconcile-operation').length, 1);
    manager.store.close?.();
  }
});

test('task dependencies reject missing and cyclic graphs and enforce sequential activation', () => {
  const workspaceRoot = tempWorkspace('otm-dependencies-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-dependencies') });
  assert.throws(() => manager.start({ workspaceRoot, goal: 'Missing', tasks: [{ id: 'a', title: 'A', dependsOn: ['missing'] }] }), { code: 'INVALID_DEPENDENCIES' });
  assert.throws(() => manager.start({ workspaceRoot, goal: 'Cycle', tasks: [{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] }] }), { code: 'CYCLIC_DEPENDENCIES' });
  const started = manager.start({ workspaceRoot, goal: 'Ordered', tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', dependsOn: ['a'] }] });
  assert.equal(started.run.currentTaskId, 'a');
  assert.throws(() => manager.markTaskActive({ workspaceRoot, taskId: 'b', allowSwitch: true }), { code: 'DEPENDENCIES_INCOMPLETE' });
});

test('reopening an internal step clears its stale completion timestamp', () => {
  const workspaceRoot = tempWorkspace('otm-step-reopen-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-step-reopen') });
  const started = manager.start({ workspaceRoot, goal: 'Step reopen', tasks: [{ title: 'Task', internalSteps: ['Step'] }] });
  const taskId = started.snapshot.tasks[0].id;
  manager.progress({ workspaceRoot, taskId, internalStepIndex: 0, internalStepStatus: 'done', message: 'Done' });
  manager.progress({ workspaceRoot, taskId, internalStepIndex: 0, internalStepStatus: 'active', message: 'Reopened' });
  assert.equal(manager.store.getTask(taskId).metadata.internalSteps[0].completedAt, undefined);
});

test('mutations reject stale expected route revisions with the current revision', () => {
  const workspaceRoot = tempWorkspace('otm-revision-conflict-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-revision-conflict') });
  const started = manager.start({ workspaceRoot, goal: 'Revision', tasks: [{ title: 'Task' }] });
  assert.throws(() => manager.reconcile({ workspaceRoot, runId: started.run.id, expectedRevision: 0, prompt: 'stale' }), (error) => error.code === 'REVISION_CONFLICT' && error.details.currentRevision === 1);
});

test('every task lifecycle mutation advances the durable route revision', () => {
  const workspaceRoot = tempWorkspace('otm-revision-advance-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-revision-advance') });
  const started = manager.start({ workspaceRoot, goal: 'Revision advance', tasks: [{ title: 'Task' }] });
  const taskId = started.snapshot.tasks[0].id;
  const first = manager.progress({ workspaceRoot, taskId, expectedRevision: 1, message: 'Checkpoint' });
  assert.equal(first.run.routeRevision, 2);
  assert.throws(() => manager.blockTask({ workspaceRoot, taskId, expectedRevision: 1, reason: 'stale' }), { code: 'REVISION_CONFLICT' });
  const blocked = manager.blockTask({ workspaceRoot, taskId, expectedRevision: 2, reason: 'Current mutation' });
  assert.equal(blocked.run.routeRevision, 3);
});

test('CLI uninstall dry-run performs no store or workspace mutations', async () => {
  const workspaceRoot = tempWorkspace('otm-cli-uninstall-dry-run-');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-cli-uninstall-state-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const workspaceBefore = fs.readdirSync(workspaceRoot).sort();
  const stateBefore = fs.readdirSync(stateDir).sort();
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(String(value));
  try {
    const outcome = await handleCli({ argv: ['uninstall', '--dry-run', '--json'], cwd: workspaceRoot, stdin: '', packageRoot, env: { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: stateDir } });
    assert.equal(outcome.exitCode, 0);
  } finally { console.log = originalLog; }
  assert.deepEqual(fs.readdirSync(workspaceRoot).sort(), workspaceBefore);
  assert.deepEqual(fs.readdirSync(stateDir).sort(), stateBefore);
  assert.equal(JSON.parse(output.at(-1)).dryRun, true);
});

test('CLI status, list-runs, and history support JSON operational output', async () => {
  const workspaceRoot = tempWorkspace('otm-cli-operations-');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-cli-operations-state-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: stateDir, CODEX_THREAD_ID: 'cli-session' };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const started = manager.start({ workspaceRoot, goal: 'CLI operations', tasks: [{ title: 'Inspect history' }] });
  const originalLog = console.log;
  const output = [];
  console.log = (value) => output.push(String(value));
  try {
    await handleCli({ argv: ['status', '--json'], cwd: workspaceRoot, stdin: '', packageRoot, env });
    await handleCli({ argv: ['list-runs', '--json'], cwd: workspaceRoot, stdin: '', packageRoot, env });
    await handleCli({ argv: ['history', '--run-id', started.run.id, '--json'], cwd: workspaceRoot, stdin: '', packageRoot, env });
  } finally { console.log = originalLog; }
  assert.equal(JSON.parse(output[0]).run.id, started.run.id);
  assert.equal(JSON.parse(output[1]).runs[0].id, started.run.id);
  assert.equal(JSON.parse(output[2]).events[0].eventType, 'run_started');
});

test('CLI backup and confirmed restore protect JSON durable state', async () => {
  const workspaceRoot = tempWorkspace('otm-cli-backup-');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-cli-backup-state-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: stateDir };
  const statePath = path.join(stateDir, 'json', 'state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, '{"marker":"original"}\n', 'utf8');
  const backupPath = path.join(stateDir, 'copy.json');
  const originalLog = console.log;
  console.log = () => {};
  try {
    await handleCli({ argv: ['backup', '--output', backupPath], cwd: workspaceRoot, stdin: '', packageRoot, env });
    fs.writeFileSync(statePath, '{"marker":"changed"}\n', 'utf8');
    await assert.rejects(() => handleCli({ argv: ['restore', '--input', backupPath], cwd: workspaceRoot, stdin: '', packageRoot, env }), /requires --confirm/);
    await handleCli({ argv: ['restore', '--input', backupPath, '--confirm'], cwd: workspaceRoot, stdin: '', packageRoot, env });
  } finally { console.log = originalLog; }
  assert.equal(fs.readFileSync(statePath, 'utf8'), '{"marker":"original"}\n');
});

test('CLI SQLite backup produces a consistent queryable database image', async () => {
  const workspaceRoot = tempWorkspace('otm-cli-sqlite-backup-');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-cli-sqlite-backup-state-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env, OTM_STORAGE: 'sqlite', OTM_STATE_DIR: stateDir };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const started = manager.start({ workspaceRoot, goal: 'Backup SQLite', tasks: [{ title: 'Persist a task' }] });
  manager.store.close();
  const backupPath = path.join(stateDir, 'copy.sqlite');
  const originalLog = console.log;
  console.log = () => {};
  try { await handleCli({ argv: ['backup', '--output', backupPath], cwd: workspaceRoot, stdin: '', packageRoot, env }); } finally { console.log = originalLog; }
  const BetterSqlite3 = loadBetterSqlite3();
  const copy = new BetterSqlite3(backupPath, { readonly: true });
  try { assert.equal(copy.prepare('SELECT id FROM runs WHERE id = ?').get(started.run.id).id, started.run.id); } finally { copy.close(); }
});

test('historical export and import preserve terminal workspace records but reject active routes', async () => {
  const workspaceRoot = tempWorkspace('otm-export-import-');
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const sourceEnv = testEnv('otm-export-source');
  const source = createTaskManager({ cwd: workspaceRoot, env: sourceEnv });
  const started = source.start({ workspaceRoot, goal: 'Export terminal history', tasks: [{ title: 'Finish exportable work' }] });
  const task = started.snapshot.tasks[0];
  for (const step of task.internalSteps) source.progress({ workspaceRoot, taskId: task.id, internalStepId: step.id, evidence: { kind: 'manual_note', summary: `Completed ${step.title}` } });
  source.completeTask({ workspaceRoot, taskId: task.id, evidence: { kind: 'test_result', summary: 'terminal evidence' } });
  source.finalizeTurn({ workspaceRoot, operationId: 'export-history' });
  source.upsertMemory({ workspaceRoot, id: 'export-memory', title: 'Exported memory', body: 'preserve me' });
  const document = source.exportWorkspace({ workspaceRoot });
  assert.equal(document.schemaVersion, 'otm.export.v1');
  assert.equal(document.runs.length, 1);
  const outputPath = path.join(os.tmpdir(), `otm-export-${Date.now()}-${Math.random()}.json`);
  const logged = [];
  const originalLog = console.log;
  console.log = (value) => logged.push(String(value));
  try {
    await handleCli({ argv: ['export', '--workspace', workspaceRoot, '--output', outputPath, '--json'], cwd: workspaceRoot, stdin: '', packageRoot, env: sourceEnv });
  } finally { console.log = originalLog; }
  assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).runs[0].id, document.runs[0].id);
  assert.equal(JSON.parse(logged.at(-1)).counts.runs, 1);

  const targetEnv = testEnv('otm-export-target');
  const target = createTaskManager({ cwd: workspaceRoot, env: targetEnv });
  const imported = target.importHistorical({ workspaceRoot, document });
  assert.equal(imported.imported.runs, 1);
  assert.equal(target.listRuns({ workspaceRoot }).runs[0].id, document.runs[0].id);
  assert.equal(target.inspectMemory({ workspaceRoot, id: 'export-memory' }).entry.title, 'Exported memory');
  assert.throws(() => target.importHistorical({ workspaceRoot, document }), { code: 'IMPORT_CONFLICT' });

  const activeDocument = source.exportWorkspace({ workspaceRoot });
  activeDocument.runs[0] = { ...activeDocument.runs[0], status: 'active', finalizedAt: null };
  assert.throws(() => target.importHistorical({ workspaceRoot, document: activeDocument }), { code: 'IMPORT_ACTIVE_RUN_FORBIDDEN' });
});

test('evidence redacts common credentials before durable storage', () => {
  const workspaceRoot = tempWorkspace('otm-redaction-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-redaction') });
  const started = manager.start({ workspaceRoot, goal: 'Redact evidence', tasks: [{ title: 'Check evidence' }] });
  const taskId = started.snapshot.tasks[0].id;
  manager.progress({ workspaceRoot, taskId, message: 'authorization: Bearer abcdefghijklmnop', evidence: { kind: 'command_result', summary: 'token=secret-value', command: 'curl -H "Authorization: Bearer abcdefghijklmnop" --api-key=very-secret', notes: { password: 'not-safe', visible: 'safe' } } });
  const evidence = manager.store.getTask(taskId).evidence.at(-1);
  assert.doesNotMatch(JSON.stringify(evidence), /secret-value|abcdefghijklmnop|not-safe/);
  assert.match(JSON.stringify(evidence), /\[REDACTED\]/);
  assert.equal(evidence.notes.visible, 'safe');
});

test('both storage backends reject unscoped cache deletion', () => {
  const json = new JsonStore({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'otm-json-delete-selector-')) });
  json.init();
  assert.throws(() => json.deleteCache({}), { code: 'CACHE_SELECTOR_REQUIRED' });
  const BetterSqlite3 = loadBetterSqlite3();
  assert.ok(BetterSqlite3, 'better-sqlite3 is required');
  const sqlite = new SqliteStore({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'otm-sqlite-delete-selector-')) });
  sqlite.init();
  assert.throws(() => sqlite.deleteCache({}), { code: 'CACHE_SELECTOR_REQUIRED' });
  sqlite.close();
});

test('JSON and SQLite commit run mutations atomically with revision conflict protection', () => {
  const stores = [];
  const json = new JsonStore({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'otm-json-atomic-')) });
  json.init();
  stores.push(json);
  const sqlite = new SqliteStore({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'otm-sqlite-atomic-')) });
  sqlite.init();
  stores.push(sqlite);
  for (const store of stores) {
    const now = '2026-01-01T00:00:00.000Z';
    const run = { id: `run-${store.kind}`, workspaceRoot: '/workspace', sessionId: 'session', turnId: null, promptHash: null, goal: 'Atomic', status: 'active', routeRevision: 1, currentTaskId: `task-${store.kind}`, createdAt: now, updatedAt: now, finalizedAt: null, metadata: {} };
    const task = { id: `task-${store.kind}`, runId: run.id, parentId: null, stableKey: 'task', title: 'Atomic task', description: null, status: 'active', required: true, priority: 50, sortOrder: 1, createdBy: 'test', acceptanceCriteria: ['verify'], evidence: [], createdAt: now, updatedAt: now, completedAt: null, metadata: {} };
    store.createRoute({ run, tasks: [task], event: { id: `event-start-${store.kind}`, runId: run.id, turnId: null, hookEventName: null, eventType: 'run_started', idempotencyKey: `start-${store.kind}`, payload: {}, createdAt: now } });
    const nextRun = { ...run, routeRevision: 2, status: 'blocked' };
    const nextTask = { ...task, status: 'blocked' };
    store.commitRunMutation({ run: nextRun, expectedRevision: 1, tasks: [nextTask], event: { id: `event-block-${store.kind}`, runId: run.id, turnId: null, hookEventName: null, eventType: 'task_blocked', idempotencyKey: `block-${store.kind}`, payload: {}, createdAt: now } });
    assert.equal(store.getRun(run.id).routeRevision, 2);
    assert.equal(store.getTask(task.id).status, 'blocked');
    assert.equal(store.getEvents(run.id).length, 2);
    assert.throws(() => store.commitRunMutation({ run: { ...nextRun, routeRevision: 3 }, expectedRevision: 1, tasks: [nextTask] }), { code: 'REVISION_CONFLICT' });
  }
  sqlite.close();
});

test('memory list and inspect exclude expired entries while explicit purge reports exact counts', () => {
  const workspaceRoot = tempWorkspace('otm-memory-operations-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-memory-operations') });
  manager.upsertMemory({ workspaceRoot, id: 'live', title: 'Live memory', body: 'retain', expiresAt: '2099-01-01T00:00:00.000Z' });
  manager.upsertMemory({ workspaceRoot, id: 'expired', title: 'Old memory', body: 'purge', expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.deepEqual(manager.listMemory({ workspaceRoot }).entries.map((entry) => entry.id), ['live']);
  assert.equal(manager.inspectMemory({ workspaceRoot, id: 'live' }).entry.title, 'Live memory');
  assert.deepEqual(manager.purgeExpiredMemory({ workspaceRoot, dryRun: true }).matched, 1);
  assert.equal(manager.purgeExpiredMemory({ workspaceRoot }).deleted, 1);
  assert.throws(() => manager.inspectMemory({ workspaceRoot, id: 'expired' }), { code: 'MEMORY_NOT_FOUND' });
});

test('workspace-wide memory deletion requires all:true and confirmation while preview reports exact matches', () => {
  const workspaceRoot = tempWorkspace('otm-memory-delete-all-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-memory-delete-all') });
  manager.upsertMemory({ workspaceRoot, id: 'one', title: 'One', body: 'first' });
  manager.upsertMemory({ workspaceRoot, id: 'two', title: 'Two', body: 'second' });
  assert.throws(() => manager.deleteMemory({ workspaceRoot, all: true }), { code: 'MEMORY_DELETE_CONFIRMATION_REQUIRED' });
  const preview = manager.deleteMemory({ workspaceRoot, all: true, confirm: true, dryRun: true });
  assert.equal(preview.matched, 2);
  assert.equal(preview.deleted, 0);
  assert.equal(manager.deleteMemory({ workspaceRoot, all: true, confirm: true }).deleted, 2);
  assert.deepEqual(manager.listMemory({ workspaceRoot }).entries, []);
});

test('memory search ranks normalized title, tag, body, and score-hint matches', () => {
  const workspaceRoot = tempWorkspace('otm-memory-search-ranking-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-memory-search-ranking') });
  manager.upsertMemory({ workspaceRoot, id: 'low', kind: 'note', title: 'Database notes', body: 'General information', tags: ['storage'], scoreHint: 1 });
  manager.upsertMemory({ workspaceRoot, id: 'high', kind: 'note', title: 'Database migration', body: 'Database migration validation evidence', tags: ['database', 'migration'], scoreHint: 5 });
  const result = manager.searchMemory({ workspaceRoot, query: 'database migration', limit: 10 });
  assert.equal(result.entries[0].id, 'high');
  assert.equal(result.entries.some((entry) => entry.id === 'low'), true);
  assert.ok(result.entries[0].matchReasons.includes('exact phrase'));
  assert.ok(result.entries[0].matchReasons.some((reason) => reason.startsWith('title:')));
  assert.ok(result.entries[0].matchReasons.some((reason) => reason.startsWith('tags:')));
});

test('SQLite cache upserts preserve createdAt instead of replacing the row', () => {
  const store = new SqliteStore({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'otm-sqlite-cache-upsert-')) });
  store.init();
  const first = { id: 'memory-1', workspaceRoot: 'C:/workspace', kind: 'note', title: 'First', body: 'Initial', tags: [], source: {}, scoreHint: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: null };
  store.upsertCache(first);
  const updated = store.upsertCache({ ...first, title: 'Updated', body: 'Changed', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' });
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(store.listCache(first.workspaceRoot)[0].createdAt, first.createdAt);
  store.close();
});

test('persistent checklist order stays planned and completion delta names the changed task', () => {
  const workspaceRoot = tempWorkspace('otm-render-order-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-render-order') });
  const started = manager.start({ workspaceRoot, goal: 'Render order', tasks: [{ title: 'First', internalSteps: ['Verify first'] }, { title: 'Second', internalSteps: ['Verify second'] }] });
  const firstId = started.snapshot.tasks[0].id;
  manager.progress({ workspaceRoot, taskId: firstId, internalStepIndex: 0, internalStepStatus: 'done', message: 'First verified' });
  const completed = manager.completeTask({ workspaceRoot, taskId: firstId, evidence: { kind: 'test', summary: 'First passed' } });
  assert.deepEqual(completed.snapshot.tasks.map((task) => task.title), ['First', 'Second']);
  assert.match(completed.markdown, /Completed: First/);
  assert.doesNotMatch(completed.markdown, /Completed: Second/);
});
