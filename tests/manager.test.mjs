import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskManager } from '../src/core/manager.mjs';
import { installWorkspace } from '../src/install/install-workspace.mjs';
import { reviewProjectContext } from '../src/context/project-review.mjs';

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

  manager.markTaskActive({ workspaceRoot, taskId: first.id });
  assert.throws(() => manager.completeTask({ workspaceRoot, taskId: first.id }), /evidence is attached/);
  const completedFirst = manager.completeTask({ workspaceRoot, taskId: first.id, evidence: { kind: 'manual_note', summary: 'Route created.' } });
  assert.match(completedFirst.markdown, /^### OTM Progress/);
  assert.equal(completedFirst.snapshot.lastRenderedMode, 'delta');
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
