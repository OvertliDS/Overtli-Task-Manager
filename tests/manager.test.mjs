import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskManager } from '../src/core/manager.mjs';
import { installWorkspace } from '../src/install/install-workspace.mjs';
import { reviewProjectContext } from '../src/context/project-review.mjs';
import { toMcpResult } from '../src/mcp/result.mjs';

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
  const completedFirst = manager.completeTask({ workspaceRoot, taskId: first.id, evidence: { kind: 'manual_note', summary: 'Route created.' } });
  assert.match(completedFirst.markdown, /^### OTM Progress/);
  assert.equal(completedFirst.snapshot.lastRenderedMode, 'delta');
  assert.equal(completedFirst.snapshot.tasks.find((task) => task.id === second.id).status, 'active');
  assert.equal(manager.auditStop({ workspaceRoot }).stopAllowed, false);

  manager.markTaskActive({ workspaceRoot, taskId: second.id });
  manager.completeTask({ workspaceRoot, taskId: second.id, evidence: { kind: 'test_result', summary: 'Audit passed after both tasks.' } });
  assert.equal(manager.auditStop({ workspaceRoot }).stopAllowed, true);

  const finalized = manager.finalizeTurn({ workspaceRoot, clear: true });
  assert.equal(finalized.snapshot.status, 'cleared');
  assert.doesNotMatch(JSON.stringify(finalized.summaryJson), /:null/);
  assert.ok(fs.existsSync(path.join(workspaceRoot, '.codex/overtli-task-manager/current.json')));
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

test('reconcile keeps workflow order stable and chooses newly added work before final tasks', () => {
  const workspaceRoot = tempWorkspace('otm-order-');
  const manager = createTaskManager({ cwd: workspaceRoot, env: testEnv('otm-order') });
  const started = manager.start({
    workspaceRoot,
    replaceExisting: true,
    goal: 'Validate workflow ordering',
    tasks: [
      { title: 'Implement route feature', required: true },
      { title: 'Run final audit and clear route', required: true }
    ]
  });

  manager.completeTask({
    workspaceRoot,
    taskId: started.snapshot.tasks[0].id,
    evidence: { kind: 'file_change', summary: 'Feature implemented.' }
  });
  manager.reconcile({
    workspaceRoot,
    mode: 'steer',
    tasks: [{ title: 'Update README docs', required: true, acceptanceCriteria: ['Docs describe behavior'] }]
  });

  const snapshot = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  assert.equal(snapshot.currentTaskTitle, 'Update README docs');
  assert.equal(snapshot.tasks.find((task) => task.title === 'Update README docs').status, 'active');
  assert.deepEqual(snapshot.tasks.map((task) => task.title), [
    'Implement route feature',
    'Update README docs',
    'Run final audit and clear route'
  ]);

  manager.completeTask({
    workspaceRoot,
    taskId: snapshot.tasks.find((task) => task.title === 'Update README docs').id,
    evidence: { kind: 'test_result', summary: 'Docs verified.' }
  });
  manager.reconcile({
    workspaceRoot,
    mode: 'steer',
    tasks: [{ title: 'Fix status accuracy', required: true, acceptanceCriteria: ['Current task table matches header'] }]
  });

  const afterDocs = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  assert.equal(afterDocs.currentTaskTitle, 'Fix status accuracy');
  assert.equal(afterDocs.tasks.find((task) => task.title === 'Fix status accuracy').status, 'active');
  assert.equal(afterDocs.tasks.find((task) => task.title === 'Run final audit and clear route').status, 'pending');
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
  assert.deepEqual(tasks[0].metadata.internalSteps, [
    'Render policy is stable',
    'Profile current render path',
    'Avoid unnecessary writes'
  ]);

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
  assert.equal(reopened.evidence.length, 1);
  assert.equal(reopened.metadata.reopened.at(-1).previousStatus, 'done');
  assert.equal(manager.auditStop({ workspaceRoot }).stopAllowed, false);
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
