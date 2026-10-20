import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskManager } from "../src/core/manager.mjs";
import { createProviderSession } from "../src/core/provider-session.mjs";
import { runHookScript } from "../src/hooks/runner.mjs";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otm-hooks-test-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function env(name) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-state-`));
  return {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: stateDir,
    // Keep hook tests hermetic. A developer's host-evidence config (for example
    // ~/.claude/overtli-task-manager/host-evidence.json) engages the live ODC
    // owner-coverage gate, which these tests never bootstrap via SessionStart.
    // An empty module override falls through to the config path, so point the
    // config at a file that does not exist to disable the observer.
    OTM_HOST_EVIDENCE_MODULE: "",
    OTM_HOST_EVIDENCE_CONFIG: path.join(stateDir, "host-evidence.json"),
  };
}

test("Codex compaction checkpoints shared OTM state and restores it through compact SessionStart", async () => {
  const workspaceRoot = workspace();
  const sessionId = "codex-compact-session";
  const hookEnv = {
    ...env("otm-codex-compact"),
    CODEX_THREAD_ID: sessionId,
    OTM_AUTO_SYNC_AGENTS: "0",
    OTM_DEDUPE_HOOKS: "0",
  };
  const owner = createProviderSession({
    provider: "codex",
    nativeSessionId: sessionId,
  });
  const manager = createTaskManager({ cwd: workspaceRoot, env: hookEnv });
  const route = manager.start({
    workspaceRoot,
    sessionId,
    goal: "Keep the Codex route available after compaction",
    prompt: "Keep the Codex route available after compaction",
    source: "test",
    providerContext: {
      provider: owner.provider,
      providerSessionKey: owner.providerSessionKey,
      nativeSessionId: sessionId,
    },
    tasks: [{ title: "Restore canonical work context" }],
  });

  await capture(() =>
    runHookScript("pre-tool-use", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: sessionId,
        hook_event_name: "PreToolUse",
        turn_id: "compact-turn",
        tool_name: "Bash",
        tool_use_id: "codex-compact-pending",
        tool_input: { command: "long running operation" },
      }),
    }),
  );
  const beforeCompact = await capture(() =>
    runHookScript("pre-compact", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: sessionId,
        hook_event_name: "PreCompact",
        turn_id: "compact-turn",
        trigger: "manual",
      }),
    }),
  );
  assert.equal(beforeCompact.result.continue, true);
  assert.equal(beforeCompact.result.systemMessage, undefined);

  const afterCompact = await capture(() =>
    runHookScript("post-compact", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: sessionId,
        hook_event_name: "PostCompact",
        turn_id: "compact-turn",
        trigger: "manual",
      }),
    }),
  );
  assert.equal(afterCompact.result.continue, true);
  assert.equal(afterCompact.result.systemMessage, undefined);

  const compactResume = await capture(() =>
    runHookScript("session-start", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: sessionId,
        hook_event_name: "SessionStart",
        source: "compact",
      }),
    }),
  );
  assert.equal(
    compactResume.result.hookSpecificOutput.hookEventName,
    "SessionStart",
  );
  assert.match(
    compactResume.result.hookSpecificOutput.additionalContext,
    /Keep the Codex route available after compaction/,
  );
  assert.equal(compactResume.result.systemMessage, undefined);

  const run = manager.store.getRun(route.run.id);
  const events = manager.store.getEvents(route.run.id);
  assert.equal(run.sessionId, sessionId);
  assert.equal(run.status, "active");
  assert.ok(
    events.some((event) => event.eventType === "provider_checkpoint_recorded"),
    "PreCompact saves the canonical OTM checkpoint",
  );
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "provider_host_work_started" &&
        event.payload.workId === "tool:codex-compact-pending",
    ),
  );
  assert.equal(
    events.some(
      (event) =>
        event.eventType === "provider_host_work_settled" &&
        event.payload.workId === "tool:codex-compact-pending",
    ),
    false,
    "compaction does not settle active host work",
  );
  assert.equal(
    events.some((event) => event.eventType === "provider_session_ended"),
    false,
  );

  const clearResume = await capture(() =>
    runHookScript("session-start", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: sessionId,
        hook_event_name: "SessionStart",
        source: "clear",
      }),
    }),
  );
  assert.equal(clearResume.result.continue, true);
  assert.match(
    clearResume.result.systemMessage,
    /Keep the Codex route available/,
  );
  const afterClear = manager.store.getEvents(route.run.id);
  assert.ok(
    afterClear.some(
      (event) =>
        event.eventType === "provider_host_work_started" &&
        event.payload.workId === "tool:codex-compact-pending",
    ),
    "clearing chat context does not erase pending native work",
  );
  assert.equal(manager.store.getRun(route.run.id).status, "active");
  manager.close();
});

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

test("Codex hook identity cannot fall back to CODEX_THREAD_ID for ODC dispatch", async () => {
  const workspaceRoot = workspace();
  const hookEnv = {
    ...env("otm-hook-official-identity"),
    CODEX_THREAD_ID: "environment-only-session",
    OTM_DEDUPE_HOOKS: "0",
  };
  const result = await capture(() =>
    runHookScript("pre-tool-use", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        hook_event_name: "PreToolUse",
        turn_id: "identity-turn",
        tool_use_id: "identity-tool",
        tool_name: "mcp__desktop-commander__process_job",
        tool_input: { action: "start" },
      }),
    }),
  );

  assert.equal(result.result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    result.result.hookSpecificOutput.permissionDecisionReason,
    /official Codex session identity is missing or conflicting/,
  );
  const manager = createTaskManager({ cwd: workspaceRoot, env: hookEnv });
  assert.equal(manager.listRuns({ workspaceRoot }).runs.length, 0);
  manager.close();
});

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
  assert.match(
    first.result.hookSpecificOutput.additionalContext,
    /Tag every Tier 1 gate with its actual model-interpreted workType/,
  );
  assert.match(
    first.result.hookSpecificOutput.additionalContext,
    /overall route report mixed rather than forcing one lossy label/,
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

test("Codex Stop preserves a live subagent until its exact SubagentStop receipt", async () => {
  const workspaceRoot = workspace();
  const sessionId = "codex-subagent-stop-session";
  const hookEnv = {
    ...env("otm-codex-subagent-stop"),
    CODEX_THREAD_ID: sessionId,
    OTM_AUTO_SYNC_AGENTS: "0",
    OTM_DEDUPE_HOOKS: "0",
  };
  const provider = createProviderSession({
    provider: "codex",
    nativeSessionId: sessionId,
  });
  const manager = createTaskManager({ cwd: workspaceRoot, env: hookEnv });
  const route = manager.start({
    workspaceRoot,
    sessionId,
    providerContext: {
      provider: provider.provider,
      providerSessionKey: provider.providerSessionKey,
      nativeSessionId: sessionId,
    },
    goal: "Wait for the native child to finish before clearing the route",
    tasks: [{ title: "Finish the routed work" }],
  });
  const task = manager.store.getTask(route.snapshot.tasks[0].id);
  manager.reconcile({
    workspaceRoot,
    prompt:
      "Review this isolated test route as one complete validation action.",
    tasks: [
      {
        stableKey: task.stableKey,
        title: task.title,
        acceptanceCriteria: task.acceptanceCriteria,
        internalSteps: [
          {
            title: "Verify the host child lifecycle",
            source: "test_fixture",
            atomic: true,
            atomicRationale: "This test isolates the Stop lifecycle behavior.",
          },
        ],
        metadata: {
          decomposition: {
            version: 2,
            source: "test_fixture",
            needsModelReview: false,
          },
        },
      },
    ],
  });
  manager.progress({
    workspaceRoot,
    taskId: task.id,
    message: "The exact native child lifecycle has been exercised.",
    internalStepTitle: "Verify the host child lifecycle",
    internalStepStatus: "done",
    evidence: {
      kind: "internal_step",
      summary: "The tested native child lifecycle was exercised.",
    },
  });
  manager.completeTask({
    workspaceRoot,
    runId: route.run.id,
    taskId: route.snapshot.tasks[0].id,
    evidence: { kind: "test_result", summary: "Route acceptance passed." },
  });

  const childPayload = {
    cwd: workspaceRoot,
    session_id: sessionId,
    turn_id: "codex-subagent-turn-1",
    agent_id: "native-agent-17",
    agent_type: "explorer",
  };
  await capture(() =>
    runHookScript("subagent-start", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        ...childPayload,
        hook_event_name: "SubagentStart",
      }),
    }),
  );
  const blocked = await capture(() =>
    runHookScript("stop", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: sessionId,
        hook_event_name: "Stop",
        turn_id: "codex-subagent-stop-pending",
      }),
    }),
  );
  assert.equal(blocked.result.decision, "block");
  assert.match(blocked.result.reason, /HOST_WORK_PENDING/);
  assert.equal(manager.store.getRun(route.run.id).status, "ready_to_finalize");

  await capture(() =>
    runHookScript("subagent-stop", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        ...childPayload,
        hook_event_name: "SubagentStop",
      }),
    }),
  );
  const allowed = await capture(() =>
    runHookScript("stop", {
      cwd: workspaceRoot,
      env: hookEnv,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: sessionId,
        hook_event_name: "Stop",
        turn_id: "codex-subagent-stop-settled",
      }),
    }),
  );
  assert.equal(allowed.result.continue, true);
  assert.equal(allowed.result.decision, undefined);
  assert.equal(manager.store.getRun(route.run.id).status, "cleared");
  manager.close();
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
