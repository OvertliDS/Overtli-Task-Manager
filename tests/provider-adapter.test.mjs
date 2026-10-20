import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createProviderAdapter,
  PROVIDER_ADAPTER_API_VERSION,
} from "../src/core/provider-adapter.mjs";
import {
  CLAUDE_HOOK_EVENTS,
  createProviderEnvironment,
  createProviderSession,
  mapClaudeHookPayload,
} from "../src/core/provider-session.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";

function workspace() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-provider-workspace-"),
  );
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function makeEnvironment(name) {
  return {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `${name}-state-`)),
    OTM_SESSION_ID: "host-session-must-not-win",
    CODEX_THREAD_ID: "host-codex-session-must-not-win",
  };
}

function reviewedAtomicTask(title) {
  return {
    title,
    internalSteps: [
      {
        title: `Verify ${title}`,
        source: "test_fixture",
        atomic: true,
        atomicRationale: "This test isolates provider-bound lifecycle wiring.",
      },
    ],
    metadata: {
      decomposition: {
        version: 2,
        source: "test_fixture",
        needsModelReview: false,
      },
    },
  };
}

test("provider sessions preserve Codex identity and namespace Claude identities", () => {
  const codex = createProviderSession({
    provider: "codex",
    nativeSessionId: " codex-session-1 ",
  });
  const claude = createProviderSession({
    provider: "claude",
    nativeSessionId: "claude-session-1",
  });
  const sameClaude = createProviderSession({
    provider: "claude",
    nativeSessionId: "claude-session-1",
  });
  const otherClaude = createProviderSession({
    provider: "claude",
    nativeSessionId: "claude-session-2",
  });

  assert.equal(codex.sessionId, "codex-session-1");
  assert.match(claude.sessionId, /^otm-provider:claude:v1:[a-f0-9]{64}$/);
  assert.equal(claude.sessionId, sameClaude.sessionId);
  assert.notEqual(claude.sessionId, otherClaude.sessionId);
  assert.notEqual(claude.sessionId, codex.sessionId);
  assert.equal(claude.sessionId.includes("claude-session-1"), false);
  assert.equal(claude.providerSessionKey.startsWith("claude:"), true);
  assert.throws(
    () =>
      createProviderSession({ provider: "untrusted", nativeSessionId: "x" }),
    { code: "INVALID_PROVIDER" },
  );
  assert.throws(
    () => createProviderSession({ provider: "claude", nativeSessionId: " " }),
    { code: "PROVIDER_SESSION_REQUIRED" },
  );
});

test("provider environment removes host session claims without mutating the caller", () => {
  const env = {
    OTM_SESSION_ID: "otm-host-id",
    CODEX_THREAD_ID: "codex-host-id",
    PATH: "safe-path",
  };
  const scoped = createProviderEnvironment(env);

  assert.deepEqual(scoped, { PATH: "safe-path" });
  assert.deepEqual(env, {
    OTM_SESSION_ID: "otm-host-id",
    CODEX_THREAD_ID: "codex-host-id",
    PATH: "safe-path",
  });
});

test("Claude hook identity uses session_id and agent_id from supported event payloads", () => {
  const payloads = [
    { hook_event_name: "SessionStart", source: "resume" },
    { hook_event_name: "UserPromptSubmit", prompt: "continue" },
    {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__otm__otm_progress",
      tool_input: { runId: "run-1" },
      tool_use_id: "toolu-pre-1",
      agent_id: "agent-observing-tool-1",
      agent_type: "Explore",
      provider: "codex",
    },
    {
      hook_event_name: "PostToolUse",
      tool_name: "mcp__otm__otm_progress",
      tool_input: { runId: "run-1" },
      tool_response: { ok: true },
      tool_use_id: "toolu-post-1",
      duration_ms: 10,
    },
    {
      hook_event_name: "PostToolUseFailure",
      tool_name: "mcp__otm__otm_progress",
      tool_input: { runId: "run-1" },
      tool_use_id: "toolu-failed-1",
      error: "route unavailable",
      is_interrupt: false,
      duration_ms: 11,
    },
    {
      hook_event_name: "SubagentStart",
      agent_id: "agent-start-1",
      agent_type: "Explore",
    },
    {
      hook_event_name: "SubagentStop",
      agent_id: "agent-stop-1",
      agent_type: "Explore",
      stop_hook_active: false,
      agent_transcript_path: "C:\\private\\transcript.jsonl",
      last_assistant_message: "Finished",
      background_tasks: [],
      session_crons: [],
    },
    {
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "Continue working",
      background_tasks: [],
      session_crons: [],
    },
    {
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: null,
    },
    {
      hook_event_name: "PostCompact",
      trigger: "auto",
      compact_summary: "Compacted context summary",
    },
    { hook_event_name: "SessionEnd", reason: "resume" },
  ].map((event) => ({
    session_id: "claude-hook-session-1",
    ...event,
  }));

  assert.deepEqual(
    payloads.map((payload) => payload.hook_event_name),
    CLAUDE_HOOK_EVENTS,
  );

  const mapped = payloads.map(mapClaudeHookPayload);
  assert.equal(
    new Set(mapped.map((identity) => identity.session.sessionId)).size,
    1,
  );
  for (const [index, identity] of mapped.entries()) {
    assert.equal(identity.provider, "claude");
    assert.equal(identity.eventName, payloads[index].hook_event_name);
    assert.equal(identity.nativeSessionId, "claude-hook-session-1");
    assert.match(identity.session.sessionId, /^otm-provider:claude:v1:/);
  }

  assert.equal(mapped[5].agentId, "agent-start-1");
  assert.equal(mapped[5].workerNativeSessionId, "agent-start-1");
  assert.equal(mapped[6].agentId, "agent-stop-1");
  assert.equal(mapped[6].workerNativeSessionId, "agent-stop-1");
  assert.equal(mapped[2].agentId, "agent-observing-tool-1");
  assert.equal("workerNativeSessionId" in mapped[2], false);
  assert.throws(
    () =>
      mapClaudeHookPayload({
        hook_event_name: "SubagentStart",
        session_id: "claude-hook-session-1",
      }),
    { code: "CLAUDE_AGENT_ID_REQUIRED" },
  );
  assert.throws(
    () =>
      mapClaudeHookPayload({
        hook_event_name: "MessageDisplay",
        session_id: "claude-hook-session-1",
      }),
    { code: "UNSUPPORTED_CLAUDE_HOOK_EVENT" },
  );
});

test("provider adapter reconciles new gates inside its bound session", () => {
  const workspaceRoot = workspace();
  const env = makeEnvironment("otm-provider-reconcile");
  const store = new JsonStore({
    stateDir: path.join(env.OTM_STATE_DIR, "json"),
  });
  store.init();
  const adapter = createProviderAdapter({
    provider: "claude",
    nativeSessionId: "claude-reconcile-session",
    workspaceRoot,
    env,
    store,
  });
  const started = adapter.startTask({
    workspaceRoot,
    goal: "Provider reconciliation",
    tasks: [reviewedAtomicTask("Existing gate")],
  });

  const reconciled = adapter.reconcileTask({
    runId: started.run.id,
    mode: "append",
    tasks: [reviewedAtomicTask("Added gate")],
  });

  assert.equal(reconciled.changed, 1);
  assert.equal(reconciled.snapshot.tasks.length, 2);
  assert.equal(reconciled.run.sessionId, adapter.session.sessionId);
  store.close();
});

test("provider adapter isolates route access and records scoped checkpoint and usage attribution", () => {
  const workspaceRoot = workspace();
  const env = makeEnvironment("otm-provider-adapter");
  const store = new JsonStore({
    stateDir: path.join(env.OTM_STATE_DIR, "json"),
  });
  store.init();
  const codex = createProviderAdapter({
    provider: "codex",
    nativeSessionId: "codex-session-1",
    workspaceRoot,
    env,
    store,
  });
  const claude = createProviderAdapter({
    provider: "claude",
    nativeSessionId: "claude-session-1",
    workspaceRoot,
    env,
    store,
  });

  assert.equal(codex.apiVersion, PROVIDER_ADAPTER_API_VERSION);
  const codexRoute = codex.startTask({
    workspaceRoot,
    goal: "Codex route",
    tasks: [{ title: "Codex-only gate" }],
  });
  const claudeRoute = claude.startTask({
    workspaceRoot,
    goal: "Claude route",
    tasks: [{ title: "Claude-only gate" }],
  });

  assert.equal(codexRoute.run.sessionId, "codex-session-1");
  assert.equal(claudeRoute.run.sessionId, claude.session.sessionId);
  assert.notEqual(codexRoute.run.sessionId, claudeRoute.run.sessionId);
  const claudeTaskId = claudeRoute.snapshot.tasks[0].id;
  const active = claude.markTaskActive({
    runId: claudeRoute.run.id,
    taskId: claudeTaskId,
  });
  assert.equal(active.snapshot.tasks[0].status, "active");
  const progress = claude.recordProgress({
    runId: claudeRoute.run.id,
    taskId: claudeTaskId,
    message: "Claude is working on its own route.",
  });
  assert.equal(progress.run.id, claudeRoute.run.id);
  const evidence = claude.recordEvidence({
    runId: claudeRoute.run.id,
    taskId: claudeTaskId,
    evidence: {
      kind: "test_result",
      summary: "Provider adapter fixture evidence.",
    },
  });
  assert.equal(
    evidence.snapshot.tasks[0].evidence.at(-1).summary,
    "Provider adapter fixture evidence.",
  );
  assert.equal(
    claude.auditStop({ runId: claudeRoute.run.id }).stopAllowed,
    false,
  );
  assert.throws(
    () =>
      claude.recordProgress({
        runId: codexRoute.run.id,
        message: "cross-route",
      }),
    (error) =>
      ["SESSION_SCOPE_MISMATCH", "PROVIDER_RUN_SCOPE_MISMATCH"].includes(
        error.code,
      ),
  );
  assert.throws(() => claude.snapshot({ sessionId: "another-session" }), {
    code: "PROVIDER_SESSION_MISMATCH",
  });
  assert.throws(() => claude.snapshot({ provider: "codex" }), {
    code: "PROVIDER_IDENTITY_CONFLICT",
  });

  const checkpoint = claude.checkpoint({ runId: claudeRoute.run.id });
  assert.equal(checkpoint.event.eventType, "provider_checkpoint_recorded");
  assert.equal(checkpoint.event.payload.provider, "claude");
  assert.equal(checkpoint.checkpoint.includes("claude-session-1"), false);
  assert.equal(
    claude
      .searchProjectMemory({ workspaceRoot, query: "checkpoint" })
      .entries.some((entry) => entry.id === checkpoint.event.id),
    false,
  );
  assert.ok(
    store.getEvents(claudeRoute.run.id).some(
      (event) => event.id === checkpoint.event.id,
    ),
  );

  const usageEvent = claude.recordUsageAttribution({
    runId: claudeRoute.run.id,
    modelId: "claude-sonnet-4-5",
    role: "root",
    inputTokens: 1200,
    outputTokens: 350,
    usage: { cacheReadInputTokens: 50, subscriptionPercent: null },
    apiEquivalentCostUsdEstimate: 0.03,
    outcome: "completed",
    operationId: "turn-usage-1",
  });
  assert.equal(usageEvent.eventType, "provider_usage_attributed");
  assert.equal(usageEvent.payload.provider, "claude");
  assert.equal(usageEvent.payload.inputTokens, 1200);
  assert.equal(usageEvent.payload.usage.subscriptionPercent, null);
  assert.equal(
    JSON.stringify(usageEvent.payload).includes("claude-session-1"),
    false,
  );
  assert.throws(
    () =>
      claude.recordUsageAttribution({
        runId: claudeRoute.run.id,
        inputTokens: -1,
      }),
    { code: "INVALID_USAGE_ATTRIBUTION" },
  );
  assert.throws(
    () =>
      claude.recordUsageAttribution({
        runId: claudeRoute.run.id,
        taskId: "not-a-route-task",
      }),
    { code: "TASK_NOT_FOUND" },
  );

  store.close();
});

test("provider namespaces persist distinctly through SQLite store reopen", () => {
  const workspaceRoot = workspace();
  const env = makeEnvironment("otm-provider-sqlite");
  const stateDir = path.join(env.OTM_STATE_DIR, "sqlite");
  let store = new SqliteStore({ stateDir });
  store.init();

  const codex = createProviderAdapter({
    provider: "codex",
    nativeSessionId: "codex-sqlite-session",
    workspaceRoot,
    env,
    store,
  });
  const claude = createProviderAdapter({
    provider: "claude",
    nativeSessionId: "claude-sqlite-session",
    workspaceRoot,
    env,
    store,
  });
  const codexRoute = codex.startTask({
    workspaceRoot,
    goal: "Codex SQLite route",
    tasks: [{ title: "Codex SQLite gate" }],
  });
  const claudeRoute = claude.startTask({
    workspaceRoot,
    goal: "Claude SQLite route",
    tasks: [{ title: "Claude SQLite gate" }],
  });
  store.close();

  store = new SqliteStore({ stateDir });
  store.init();
  const reloadedCodex = createProviderAdapter({
    provider: "codex",
    nativeSessionId: "codex-sqlite-session",
    workspaceRoot,
    env,
    store,
  });
  const reloadedClaude = createProviderAdapter({
    provider: "claude",
    nativeSessionId: "claude-sqlite-session",
    workspaceRoot,
    env,
    store,
  });

  assert.equal(
    reloadedCodex.snapshot({ runId: codexRoute.run.id }).run.sessionId,
    "codex-sqlite-session",
  );
  assert.equal(
    reloadedClaude.snapshot({ runId: claudeRoute.run.id }).run.sessionId,
    claude.session.sessionId,
  );
  assert.throws(
    () => reloadedClaude.snapshot({ runId: codexRoute.run.id }),
    (error) =>
      ["SESSION_SCOPE_MISMATCH", "PROVIDER_RUN_SCOPE_MISMATCH"].includes(
        error.code,
      ),
  );

  store.close();
});

test("provider adapter resumes, completes, audits, and finalizes one scoped route", () => {
  const workspaceRoot = workspace();
  const env = makeEnvironment("otm-provider-lifecycle");
  const store = new JsonStore({
    stateDir: path.join(env.OTM_STATE_DIR, "json"),
  });
  store.init();
  const adapter = createProviderAdapter({
    provider: "claude",
    nativeSessionId: "claude-lifecycle-session",
    workspaceRoot,
    env,
    store,
  });
  const started = adapter.startTask({
    workspaceRoot,
    goal: "Provider lifecycle",
    tasks: [reviewedAtomicTask("Lifecycle gate")],
  });
  const taskId = started.snapshot.tasks[0].id;

  adapter.markTaskActive({ runId: started.run.id, taskId });
  const blocked = adapter.blockTask({
    runId: started.run.id,
    taskId,
    reason: "Waiting for a test fixture.",
  });
  assert.equal(blocked.run.status, "blocked");
  const resumed = adapter.resumeRun({
    runId: started.run.id,
    taskId,
    reason: "The fixture is ready.",
  });
  assert.equal(resumed.run.status, "active");

  adapter.recordProgress({
    runId: started.run.id,
    taskId,
    internalStepIndex: 0,
    internalStepStatus: "done",
    message: "The adapter lifecycle is wired.",
  });
  const completed = adapter.completeTask({
    runId: started.run.id,
    taskId,
    evidence: { kind: "test_result", summary: "Scoped lifecycle test passed." },
  });
  assert.equal(completed.snapshot.tasks[0].status, "done");
  assert.equal(adapter.auditStop({ runId: started.run.id }).stopAllowed, true);

  const finalized = adapter.finalizeTurn({
    runId: started.run.id,
    summaryId: "summary_provider_lifecycle",
    outcome: "completed",
  });
  assert.equal(finalized.run.status, "completed");
  assert.equal(finalized.summary.id, "summary_provider_lifecycle");
  assert.equal(
    adapter.snapshot({ runId: started.run.id }).run.sessionId,
    adapter.session.sessionId,
  );

  store.close();
});

test("subagent attribution records same-provider ownership and rejects cross-provider claims", () => {
  const workspaceRoot = workspace();
  const env = makeEnvironment("otm-provider-subagent");
  const store = new JsonStore({
    stateDir: path.join(env.OTM_STATE_DIR, "json"),
  });
  store.init();
  const adapter = createProviderAdapter({
    provider: "claude",
    nativeSessionId: "claude-root-session",
    workspaceRoot,
    env,
    store,
  });
  const route = adapter.startTask({
    workspaceRoot,
    goal: "Subagent attribution",
    tasks: [{ title: "Owned gate" }],
  });
  const hookIdentity = mapClaudeHookPayload({
    hook_event_name: "SubagentStart",
    session_id: "claude-root-session",
    agent_id: "agent-worker-1",
    agent_type: "Explore",
  });
  const event = adapter.recordSubagentOwnership({
    runId: route.run.id,
    taskId: route.snapshot.tasks[0].id,
    workerNativeSessionId: hookIdentity.workerNativeSessionId,
    operationId: "ownership-1",
  });

  assert.equal(event.eventType, "provider_subagent_ownership_recorded");
  assert.equal(event.payload.ownerProvider, "claude");
  assert.equal(event.payload.workerProvider, "claude");
  assert.notEqual(
    event.payload.ownerSessionKey,
    event.payload.workerSessionKey,
  );
  assert.equal(JSON.stringify(event.payload).includes("agent-worker-1"), false);
  assert.throws(
    () =>
      adapter.recordSubagentOwnership({
        runId: route.run.id,
        taskId: route.snapshot.tasks[0].id,
        workerProvider: "codex",
        workerNativeSessionId: "codex-worker-session",
      }),
    { code: "CROSS_PROVIDER_OPERATION_FORBIDDEN" },
  );
  assert.throws(
    () =>
      adapter.recordUsageAttribution({
        runId: route.run.id,
        workerProvider: "codex",
      }),
    { code: "CROSS_PROVIDER_OPERATION_FORBIDDEN" },
  );

  store.close();
});
