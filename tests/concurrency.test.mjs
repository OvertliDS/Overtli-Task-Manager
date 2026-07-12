import './support/temp-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTaskManager } from '../src/core/manager.mjs';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-concurrency-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

function stateEnv(name) {
  return { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `${name}-state-`)), CODEX_THREAD_ID: 'concurrency-session' };
}

const CHILD = `
  import { createTaskManager } from './src/core/manager.mjs';
  const manager = createTaskManager({ cwd: process.env.OTM_TEST_WORKSPACE, env: process.env });
  const input = JSON.parse(process.env.OTM_TEST_INPUT);
  try {
    let result;
    if (input.operation === 'progress') result = manager.progress(input.args);
    if (input.operation === 'reconcile') result = manager.reconcile(input.args);
    if (input.operation === 'complete') result = manager.completeTask(input.args);
    if (input.operation === 'clear') result = manager.clearCurrent(input.args);
    process.stdout.write(JSON.stringify({ ok: true, revision: result.run?.routeRevision || null }));
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code || error.name })); }
`;

function concurrentChild(packageRoot, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD], {
      cwd: packageRoot,
      env: { ...env, OTM_TEST_WORKSPACE: input.args.workspaceRoot, OTM_TEST_INPUT: JSON.stringify(input) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`invalid child result: ${stdout}`)); }
    });
  });
}

async function race(packageRoot, env, input) {
  return Promise.all([concurrentChild(packageRoot, env, input), concurrentChild(packageRoot, env, input)]);
}

function terminalizeInternalSteps(manager, workspaceRoot, taskId) {
  const steps = manager.store.getTask(taskId).metadata.internalSteps || [];
  for (let index = 0; index < steps.length; index += 1) {
    manager.progress({ workspaceRoot, taskId, internalStepIndex: index, internalStepStatus: 'done', message: `Prepare concurrent terminal transition ${index}.` });
  }
}

test('separate processes serialize progression, reconciliation, completion, and clearing with revision safety', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  for (const operation of ['progress', 'reconcile', 'complete', 'clear']) {
    const workspaceRoot = workspace();
    const env = stateEnv(`otm-${operation}-race`);
    const manager = createTaskManager({ cwd: workspaceRoot, env });
    const started = manager.start({ workspaceRoot, goal: `${operation} race`, tasks: [{ title: 'Race task' }] });
    const taskId = started.snapshot.tasks[0].id;
    let input;
    if (operation === 'progress') input = { operation, args: { workspaceRoot, taskId, expectedRevision: 1, message: 'Concurrent checkpoint' } };
    if (operation === 'reconcile') input = { operation, args: { workspaceRoot, runId: started.run.id, expectedRevision: 1, changes: [{ action: 'add', title: 'Concurrent addition' }], operationId: 'concurrent-reconcile' } };
    if (operation === 'complete') {
      terminalizeInternalSteps(manager, workspaceRoot, taskId);
      input = { operation, args: { workspaceRoot, taskId, expectedRevision: manager.store.getRun(started.run.id).routeRevision, evidence: { kind: 'test_result', summary: 'Concurrent completion evidence.' } } };
    }
    if (operation === 'clear') {
      terminalizeInternalSteps(manager, workspaceRoot, taskId);
      manager.completeTask({ workspaceRoot, taskId, evidence: { kind: 'test_result', summary: 'Prepare finalization.' } });
      const finalized = manager.finalizeTurn({ workspaceRoot });
      input = { operation, args: { workspaceRoot, runId: started.run.id, expectedRevision: finalized.run.routeRevision } };
    }
    const results = await race(packageRoot, env, input);
    assert.ok(results.some((result) => result.ok), `${operation} must produce one committed result: ${JSON.stringify(results)}`);
    assert.ok(results.every((result) => result.ok || result.code === 'REVISION_CONFLICT' || result.code === 'CLEAR_REQUIRES_FINALIZATION'), `${operation} must fail safely: ${JSON.stringify(results)}`);
    const run = manager.store.getRun(started.run.id);
    if (operation === 'progress' || operation === 'reconcile') assert.equal(run.routeRevision, 2);
    if (operation === 'complete') assert.equal(run.status, 'ready_to_finalize');
    if (operation === 'clear') assert.equal(run.status, 'cleared');
  }
});
