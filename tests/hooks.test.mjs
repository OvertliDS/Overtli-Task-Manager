import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskManager } from "../src/core/manager.mjs";
import { runHookScript } from "../src/hooks/runner.mjs";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otm-hooks-test-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function env(name) {
  return {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `${name}-state-`)),
  };
}

async function capture(fn) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = function write(chunk, encoding, callback) {
    output += Buffer.isBuffer(chunk)
      ? chunk.toString(typeof encoding === "string" ? encoding : "utf8")
      : String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  try {
    return { result: await fn(), output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("duplicate hook commands emit user guidance only once per host invocation", async () => {
  const workspaceRoot = workspace();
  const hookEnv = {
    ...env("otm-hook-dedupe"),
    CODEX_THREAD_ID: "dedupe-session",
  };
  const input = JSON.stringify({
    cwd: workspaceRoot,
    hook_event_name: "UserPromptSubmit",
    turn_id: "dedupe-turn",
    session_id: "dedupe-session",
    prompt: "Implement a substantial feature.",
  });
  const first = await capture(() =>
    runHookScript("user-prompt-submit", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: input,
    }),
  );
  const duplicate = await capture(() =>
    runHookScript("user-prompt-submit", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: input,
    }),
  );
  assert.match(
    first.result.hookSpecificOutput.additionalContext,
    /Overtli Task Manager protocol is active/,
  );
  assert.equal(duplicate.result.continue, true);
  assert.equal(duplicate.result.hookSpecificOutput, undefined);
});

test("a substantive new prompt creates one durable route and directs Codex to continue its active segment", async () => {
  const workspaceRoot = workspace();
  const hookEnv = {
    ...env("otm-hook-auto-start"),
    CODEX_THREAD_ID: "auto-start-session",
  };
  const payload = {
    cwd: workspaceRoot,
    hook_event_name: "UserPromptSubmit",
    invocation_id: "auto-start-invocation",
    session_id: "auto-start-session",
    prompt:
      "Implement the following large release: Phase 1: repair the lifecycle. Phase 2: add migration tests. Phase 3: update documentation.",
  };
  const first = await capture(() =>
    runHookScript("user-prompt-submit", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify(payload),
    }),
  );
  const manager = createTaskManager({ cwd: workspaceRoot, env: hookEnv });
  const snapshot = manager.snapshot({
    workspaceRoot,
    sessionId: "auto-start-session",
    write: false,
  }).snapshot;
  assert.ok(first.result.otmRoute?.runId);
  assert.equal(snapshot.status, "active");
  assert.ok(snapshot.tasks.length >= 3);
  assert.equal(
    snapshot.tasks.filter((task) => task.status === "active").length,
    1,
  );
  assert.equal(snapshot.currentTaskId, first.result.otmRoute.currentTaskId);
  assert.match(
    first.result.hookSpecificOutput.additionalContext,
    /route was created automatically/i,
  );
  assert.match(
    first.result.hookSpecificOutput.additionalContext,
    /immediately continue work on the returned active next segment/i,
  );

  const duplicate = await capture(() =>
    runHookScript("user-prompt-submit", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify(payload),
    }),
  );
  assert.equal(duplicate.result.otmRoute, undefined);
  assert.equal(
    manager.store
      .listActiveRuns(workspaceRoot)
      .filter((run) => run.sessionId === "auto-start-session").length,
    1,
  );
});

test("auto-start can be explicitly disabled without weakening existing-route continuation", async () => {
  const workspaceRoot = workspace();
  const hookEnv = {
    ...env("otm-hook-auto-start-disabled"),
    CODEX_THREAD_ID: "auto-start-disabled",
    OTM_AUTO_START_ROUTE: "0",
  };
  const result = await capture(() =>
    runHookScript("user-prompt-submit", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: "auto-start-disabled",
        prompt: "Implement a significant hook and lifecycle repair.",
      }),
    }),
  );
  const manager = createTaskManager({ cwd: workspaceRoot, env: hookEnv });
  assert.equal(
    manager.snapshot({
      workspaceRoot,
      sessionId: "auto-start-disabled",
      write: false,
    }).run,
    null,
  );
  assert.match(
    result.result.hookSpecificOutput.additionalContext,
    /call otm_start/i,
  );
});

test("repeated Stop feedback is released and cannot create an unbounded loop", async () => {
  const workspaceRoot = workspace();
  const hookEnv = {
    ...env("otm-stop-repeat"),
    CODEX_THREAD_ID: "repeat-session",
    OTM_DEDUPE_HOOKS: "0",
  };
  const manager = createTaskManager({ cwd: workspaceRoot, env: hookEnv });
  manager.start({
    workspaceRoot,
    goal: "Incomplete route",
    tasks: [{ title: "Still open" }],
  });
  const payload = {
    cwd: workspaceRoot,
    hook_event_name: "Stop",
    turn_id: "repeat-turn",
    session_id: "repeat-session",
  };
  const first = await capture(() =>
    runHookScript("stop", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify(payload),
    }),
  );
  const repeated = await capture(() =>
    runHookScript("stop", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({ ...payload, stop_hook_active: true }),
    }),
  );
  assert.equal(first.result.decision, "block");
  assert.match(first.result.reason, /Still open/);
  assert.equal(repeated.result.continue, true);
  assert.equal(repeated.result.decision, undefined);
});

test("Stop hook process failures fail open without another stop block", () => {
  const workspaceRoot = workspace();
  const invalidStateDir = path.join(workspaceRoot, "state-file");
  fs.writeFileSync(invalidStateDir, "not a directory", "utf8");
  const hookPath = fileURLToPath(new URL("../hooks/stop.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [hookPath], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      OTM_STORAGE: "json",
      OTM_STATE_DIR: invalidStateDir,
      CODEX_THREAD_ID: "broken-stop",
    },
    input: JSON.stringify({
      cwd: workspaceRoot,
      hook_event_name: "Stop",
      session_id: "broken-stop",
    }),
    encoding: "utf8",
  });
  const output = JSON.parse(child.stdout.trim());
  assert.equal(output.continue, true);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /Stop hook warning/);
});
