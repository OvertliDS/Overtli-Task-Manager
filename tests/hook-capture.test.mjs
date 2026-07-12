import './support/temp-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskManager } from '../src/core/manager.mjs';
import { runHookScript } from '../src/hooks/runner.mjs';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-hook-capture-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

async function evidenceFor(mode, command) {
  const workspaceRoot = workspace();
  const env = { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'otm-hook-capture-state-')), CODEX_THREAD_ID: 'capture-session', OTM_COMMAND_CAPTURE: mode };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const started = manager.start({ workspaceRoot, goal: 'Capture policy', tasks: [{ title: 'Inspect capture' }] });
  await runHookScript('post-tool-use', { cwd: workspaceRoot, env, stdin: JSON.stringify({ cwd: workspaceRoot, session_id: 'capture-session', tool_name: 'Bash', tool_input: { command }, tool_response: { exit_code: 0 } }) });
  return manager.store.getTask(started.snapshot.tasks[0].id).evidence.at(-1) || null;
}

test('hook command capture policy supports none, redacted, and validation-only modes', async () => {
  const none = await evidenceFor('none', 'npm test -- token=secret-value');
  assert.ok(none);
  assert.equal(none.command, undefined);
  const validationOnlyNonValidation = await evidenceFor('validation-only', 'echo secret-value');
  assert.equal(validationOnlyNonValidation, null);
  const validationOnlyTest = await evidenceFor('validation-only', 'npm test -- --runInBand');
  assert.ok(validationOnlyTest);
  assert.match(validationOnlyTest.command, /npm test/);
  const redacted = await evidenceFor('redacted', 'npm test -- token=secret-value');
  assert.ok(redacted);
  assert.doesNotMatch(redacted.command, /secret-value/);
  assert.match(redacted.command, /\[REDACTED\]/);
});

test('hook command capture honors the injected environment over process-global state', async () => {
  const before = process.env.OTM_COMMAND_CAPTURE;
  process.env.OTM_COMMAND_CAPTURE = 'none';
  try {
    const evidence = await evidenceFor('redacted', 'npm test -- token=injected-secret');
    assert.ok(evidence?.command);
    assert.match(evidence.command, /\[REDACTED\]/);
    assert.doesNotMatch(evidence.command, /injected-secret/);
  } finally {
    if (before === undefined) delete process.env.OTM_COMMAND_CAPTURE;
    else process.env.OTM_COMMAND_CAPTURE = before;
  }
});

test('distinct tool events in one turn are not deduplicated when the host omits a tool-use id', async () => {
  const workspaceRoot = workspace();
  const env = { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'otm-hook-dedupe-state-')), CODEX_THREAD_ID: 'tool-events-session' };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const started = manager.start({ workspaceRoot, goal: 'Record distinct validation events', tasks: [{ title: 'Validate' }] });
  for (const command of ['npm test -- first', 'npm test -- second']) {
    await runHookScript('post-tool-use', {
      cwd: workspaceRoot,
      env,
      stdin: JSON.stringify({ cwd: workspaceRoot, session_id: 'tool-events-session', turn_id: 'shared-turn', tool_name: 'Bash', tool_input: { command }, tool_response: { exit_code: 0 } })
    });
  }
  const evidence = manager.store.getTask(started.snapshot.tasks[0].id).evidence;
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((item) => item.command), ['npm test -- first', 'npm test -- second']);
});

test('long hook command scratch filenames never use an untrusted tool name', async () => {
  const workspaceRoot = workspace();
  const env = { ...process.env, OTM_STORAGE: 'json', OTM_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'otm-hook-scratch-state-')), CODEX_THREAD_ID: 'scratch-session', OTM_TRACK_MCP_EVIDENCE: '1' };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const started = manager.start({ workspaceRoot, goal: 'Capture long input safely', tasks: [{ title: 'Inspect scratch evidence' }] });
  await runHookScript('post-tool-use', {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({
      cwd: workspaceRoot,
      session_id: 'scratch-session',
      tool_name: 'mcp__../../outside',
      tool_input: { command: `npm test -- ${'x'.repeat(900)}` },
      tool_response: { exit_code: 0 }
    })
  });
  const evidence = manager.store.getTask(started.snapshot.tasks[0].id).evidence.at(-1);
  assert.match(evidence.notes.scratchFile, /-command-[a-f0-9]{12}\.txt$/);
  assert.doesNotMatch(evidence.notes.scratchFile, /outside|\.\./);
  assert.ok(fs.existsSync(path.join(workspaceRoot, evidence.notes.scratchFile)));
});
