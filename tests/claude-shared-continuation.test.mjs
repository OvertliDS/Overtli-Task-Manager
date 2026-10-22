import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProviderAdapter } from "../src/core/provider-adapter.mjs";
import { createTaskManager } from "../src/core/manager.mjs";
import { createProviderSession } from "../src/core/provider-session.mjs";
import { runHookScript } from "../src/hooks/runner.mjs";
import {
  HOST_CONTINUATION_EVIDENCE_SCHEMA,
  HOST_CONTINUATION_REQUIRED_SOURCES,
} from "../src/core/continuation.mjs";
import {
  buildClaudeHookEntries,
  installClaudeHooks,
  resolveClaudeUserSettingsPath,
  rollbackClaudeHooks,
} from "../src/install/claude-settings.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";
import {
  capabilityKeyPath,
  issueClaudeSessionCapability,
  verifyClaudeSessionCapability,
} from "../src/core/claude-capability.mjs";
import { CLAUDE_OTM_TOOLS } from "../src/claude/mcp-server.mjs";
import { createStore as createConfiguredStore } from "../src/storage/store.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const claudeHookScript = path.join(packageRoot, "hooks", "claude-code.mjs");

function workspace() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-shared-continuation-"),
  );
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function createStore(kind = "json") {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `otm-${kind}-state-`));
  const store =
    kind === "sqlite"
      ? new SqliteStore({ stateDir })
      : new JsonStore({ stateDir });
  store.init();
  return { stateDir, store };
}

function adapter({
  provider,
  nativeSessionId,
  workspaceRoot,
  env,
  store,
  inspectOwnerWork,
}) {
  return createProviderAdapter({
    provider,
    nativeSessionId,
    workspaceRoot,
    env,
    store,
    ...(inspectOwnerWork ? { inspectOwnerWork } : {}),
  });
}

function reviewedAtomicTask(title) {
  return {
    title,
    internalSteps: [
      {
        title: `Verify ${title}`,
        source: "test_fixture",
        atomic: true,
        atomicRationale: "This fixture isolates shared provider ownership.",
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

function recordActivity(
  store,
  run,
  at = new Date(Date.now() - 20 * 60_000).toISOString(),
) {
  const owner = run.metadata.providerSession;
  const event = {
    id: `activity-${crypto.randomUUID()}`,
    runId: run.id,
    turnId: null,
    hookEventName: "UserPromptSubmit",
    eventType: "provider_session_activity",
    idempotencyKey: `activity-${crypto.randomUUID()}`,
    payload: {
      ownerSessionId: run.sessionId,
      providerSessionKey: owner.providerSessionKey,
      provider: owner.provider,
      nativeSessionId: owner.nativeSessionId,
      activityKind: "UserPromptSubmit",
    },
    createdAt: at,
  };
  store.recordEvent(event);
  return event;
}

function hostEvidence(input, overrides = {}) {
  const observedAt = new Date().toISOString();
  const ownerSessionId = input.ownerSession.nativeSessionId;
  const sources = HOST_CONTINUATION_REQUIRED_SOURCES.map((id) => ({
    id,
    status: "complete",
    ownerSessionId,
    observedAt,
    activeWorkCount: 0,
    unknownWorkCount: 0,
    evidenceRefs: [
      {
        recordId: `${id}:current-owner-record`,
        ownerSessionId,
        observedAt,
        path: `fixture://${id}/${ownerSessionId}`,
        sha256: crypto
          .createHash("sha256")
          .update(`${id}:${ownerSessionId}`)
          .digest("hex"),
      },
    ],
  }));
  return {
    schemaVersion: HOST_CONTINUATION_EVIDENCE_SCHEMA,
    complete: true,
    runId: input.runId,
    routeRevision: input.routeRevision,
    owner: input.ownerSession,
    lastActivityAt: input.activityAt,
    activityEventId: input.activityEventId,
    observedAt,
    activeWorkCount: 0,
    unknownWorkCount: 0,
    blockers: [],
    sources,
    ...overrides,
  };
}

function inspectOwnerWork(input) {
  return hostEvidence(input);
}

function writeClaudeStopObserver(
  stateDir,
  { coverageComplete = true, activeWorkCount = 0, unknownWorkCount = 0 } = {},
) {
  const modulePath = path.join(stateDir, "stop-host-evidence.mjs");
  fs.writeFileSync(
    modulePath,
    `export function observeHostHook() { return { observed: ${coverageComplete}, coverage: { complete: ${coverageComplete}, pendingCount: 0, code: ${coverageComplete ? "null" : '"ODC_OWNER_COVERAGE_UNKNOWN"'} }, dispatchAllowed: true, code: ${coverageComplete ? "null" : '"ODC_OWNER_COVERAGE_UNKNOWN"'} }; }
export function inspectOwnerWork(input) {
  const observedAt = new Date().toISOString();
  const ownerSessionId = input.ownerSession.nativeSessionId;
  const sources = input.requiredSources.map((id) => ({ id, status: "complete", ownerSessionId, observedAt, activeWorkCount: id === "native-broker" ? ${activeWorkCount} : 0, unknownWorkCount: id === "native-broker" ? ${unknownWorkCount} : 0, evidenceRefs: [{ recordId: id + ":fixture", ownerSessionId, observedAt, path: "fixture://" + id, sha256: "${"a".repeat(64)}" }] }));
  return { schemaVersion: "otm.host-continuation-evidence.v1", complete: true, runId: input.runId, routeRevision: input.routeRevision, owner: input.ownerSession, lastActivityAt: input.activityAt, activityEventId: input.activityEventId, observedAt, activeWorkCount: ${activeWorkCount}, unknownWorkCount: ${unknownWorkCount}, blockers: [], sources };
}
`,
    "utf8",
  );
  return modulePath;
}

function runClaudeHook(payload, { env = process.env, cwd, args = [] } = {}) {
  const result = spawnSync(process.execPath, [claudeHookScript, ...args], {
    cwd,
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function hookPayload(eventName, sessionId, extra = {}) {
  return {
    session_id: sessionId,
    hook_event_name: eventName,
    cwd: extra.cwd,
    ...extra,
  };
}

function additionalContext(result) {
  return result?.hookSpecificOutput?.additionalContext || "";
}

function capabilityFromHookResult(result) {
  const context = additionalContext(result);
  const token = /otm1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(context)?.[0];
  assert.ok(
    token,
    "Claude hook output must provide a signed session capability in official additionalContext",
  );
  return token;
}

test("shared canonical task, checkpoint history and summary remain provider-neutral", () => {
  const workspaceRoot = workspace();
  const env = { ...process.env, OTM_STORAGE: "json" };
  const { store } = createStore();
  const codex = adapter({
    provider: "codex",
    nativeSessionId: "codex-shared-read",
    workspaceRoot,
    env,
    store,
  });
  const claude = adapter({
    provider: "claude",
    nativeSessionId: "claude-shared-read",
    workspaceRoot,
    env,
    store,
  });

  const finished = codex.startTask({
    workspaceRoot,
    goal: "Shared summary route",
    tasks: [reviewedAtomicTask("Shared summary gate")],
  });
  const finishedTaskId = finished.snapshot.tasks[0].id;
  codex.markTaskActive({ runId: finished.run.id, taskId: finishedTaskId });
  codex.recordProgress({
    runId: finished.run.id,
    taskId: finishedTaskId,
    internalStepIndex: 0,
    internalStepStatus: "done",
    message: "Canonical route evidence is complete.",
  });
  codex.completeTask({
    runId: finished.run.id,
    taskId: finishedTaskId,
    evidence: {
      kind: "test_result",
      summary: "Shared history fixture passed.",
    },
  });
  codex.finalizeTurn({
    runId: finished.run.id,
    summaryId: "summary_shared_fixture",
    outcome: "completed",
  });
  const checkpoint = codex.checkpoint({ runId: finished.run.id });

  const active = codex.startTask({
    workspaceRoot,
    goal: "Shared active route",
    tasks: [reviewedAtomicTask("Shared active gate")],
  });
  const sharedTask = claude.readSharedTask({
    runId: active.run.id,
    workspaceRoot,
  });
  const history = claude.readSharedHistory({ workspaceRoot, limit: 20 });

  assert.equal(sharedTask.run.id, active.run.id);
  assert.equal(sharedTask.snapshot.tasks[0].id, active.snapshot.tasks[0].id);
  assert.ok(
    history.runs.some(
      (run) =>
        run.id === finished.run.id && run.sessionId === codex.session.sessionId,
    ),
  );
  assert.ok(
    history.summaries.some(
      (summary) => summary.id === "summary_shared_fixture",
    ),
  );
  assert.ok(
    store
      .getEvents(finished.run.id)
      .some((event) => event.id === checkpoint.event.id),
  );
  assert.equal(claude.snapshot({ write: false }).run, null);
  store.close();
});

for (const backend of ["json", "sqlite"]) {
  test(`explicit Codex to Claude and Claude to Codex continuation is exclusive in ${backend}`, () => {
    const workspaceRoot = workspace();
    const env = { ...process.env, OTM_STORAGE: backend };
    const { store } = createStore(backend);
    const codex = adapter({
      provider: "codex",
      nativeSessionId: `codex-${backend}`,
      workspaceRoot,
      env,
      store,
      inspectOwnerWork,
    });
    const claude = adapter({
      provider: "claude",
      nativeSessionId: `claude-${backend}`,
      workspaceRoot,
      env,
      store,
      inspectOwnerWork,
    });
    const route = codex.startTask({
      workspaceRoot,
      goal: "Transfer both directions",
      tasks: [reviewedAtomicTask("Transfer gate")],
    });
    const codexActivity = recordActivity(store, route.run);

    const transferredToClaude = claude.continueTask({
      runId: route.run.id,
      expectedRevision: route.run.routeRevision,
      workspaceRoot,
    });
    assert.equal(transferredToClaude.continued, true);
    assert.equal(transferredToClaude.run.sessionId, claude.session.sessionId);
    assert.equal(
      transferredToClaude.run.routeRevision,
      route.run.routeRevision + 1,
    );
    assert.equal(
      transferredToClaude.run.metadata.providerSession.provider,
      "claude",
    );
    assert.equal(
      store.getCanonicalBinding(codex.session.sessionId).status,
      "empty",
    );
    assert.equal(
      store.getCanonicalBinding(claude.session.sessionId).currentRunId,
      route.run.id,
    );
    const transferEvent = store
      .getEvents(route.run.id)
      .find(
        (event) => event.eventType === "provider_run_ownership_transferred",
      );
    assert.deepEqual(
      [
        ...new Set(transferEvent.payload.evidenceRefs.map((ref) => ref.source)),
      ].sort(),
      ["native-broker", "odc-jobs"],
    );
    assert.equal(
      transferEvent.payload.priorOwnerActivityEventId,
      codexActivity.id,
    );
    assert.throws(
      () =>
        codex.recordProgress({ runId: route.run.id, message: "stale owner" }),
      {
        code: "SESSION_SCOPE_MISMATCH",
      },
    );
    assert.equal(
      claude.readSharedTask({ runId: route.run.id, workspaceRoot }).run
        .sessionId,
      claude.session.sessionId,
    );

    const claudeActivity = recordActivity(store, transferredToClaude.run);
    const transferredToCodex = codex.continueTask({
      runId: route.run.id,
      expectedRevision: transferredToClaude.run.routeRevision,
      workspaceRoot,
    });
    assert.equal(transferredToCodex.run.sessionId, codex.session.sessionId);
    assert.equal(
      transferredToCodex.run.routeRevision,
      route.run.routeRevision + 2,
    );
    assert.equal(
      store.getCanonicalBinding(claude.session.sessionId).status,
      "empty",
    );
    assert.equal(
      store.getCanonicalBinding(codex.session.sessionId).currentRunId,
      route.run.id,
    );
    assert.ok(
      store
        .getEvents(route.run.id)
        .some(
          (event) =>
            event.eventType === "provider_run_ownership_transferred" &&
            event.payload.priorOwnerActivityEventId === claudeActivity.id,
        ),
    );
    store.close();
  });
}

test("SQLite ownership transfer rolls back both bindings and the route when its receipt write fails", () => {
  const workspaceRoot = workspace();
  const env = { ...process.env, OTM_STORAGE: "sqlite" };
  const { store } = createStore("sqlite");
  const codex = adapter({
    provider: "codex",
    nativeSessionId: "codex-atomic-transfer",
    workspaceRoot,
    env,
    store,
  });
  const claude = adapter({
    provider: "claude",
    nativeSessionId: "claude-atomic-transfer",
    workspaceRoot,
    env,
    store,
    inspectOwnerWork,
  });
  const route = codex.startTask({
    workspaceRoot,
    goal: "Keep ownership atomic across storage failure",
    tasks: [reviewedAtomicTask("Atomic transfer gate")],
  });
  recordActivity(store, route.run);
  const oldRevision = route.run.routeRevision;
  store.db.exec(`CREATE TRIGGER reject_transfer_receipt
    BEFORE INSERT ON events
    WHEN NEW.event_type = 'provider_run_ownership_transferred'
    BEGIN SELECT RAISE(ABORT, 'injected transfer failure'); END;`);

  assert.throws(
    () =>
      claude.continueTask({
        runId: route.run.id,
        expectedRevision: oldRevision,
        workspaceRoot,
      }),
    /injected transfer failure/,
  );
  assert.equal(store.getRun(route.run.id).sessionId, codex.session.sessionId);
  assert.equal(store.getRun(route.run.id).routeRevision, oldRevision);
  assert.equal(
    store.getCanonicalBinding(codex.session.sessionId).currentRunId,
    route.run.id,
  );
  assert.equal(store.getCanonicalBinding(claude.session.sessionId), null);
  assert.equal(
    store
      .getEvents(route.run.id)
      .some(
        (event) => event.eventType === "provider_run_ownership_transferred",
      ),
    false,
  );
  store.close();
});

test("continuation rejects recent owners, unknown/incomplete inventories and active jobs", () => {
  const workspaceRoot = workspace();
  const env = { ...process.env, OTM_STORAGE: "json" };
  const { store } = createStore();
  function ownedRoute(nativeSessionId, goal) {
    const owner = adapter({
      provider: "codex",
      nativeSessionId,
      workspaceRoot,
      env,
      store,
    });
    const route = owner.startTask({
      workspaceRoot,
      goal,
      tasks: [reviewedAtomicTask(`${goal} gate`)],
    });
    return { owner, route };
  }

  const recentOwner = ownedRoute("codex-recent-owner", "Recent owner");
  recordActivity(store, recentOwner.route.run, new Date().toISOString());
  const recent = adapter({
    provider: "claude",
    nativeSessionId: "claude-recent",
    workspaceRoot,
    env,
    store,
    inspectOwnerWork,
  });
  assert.throws(
    () =>
      recent.continueTask({
        runId: recentOwner.route.run.id,
        expectedRevision: recentOwner.route.run.routeRevision,
        workspaceRoot,
      }),
    { code: "OWNER_RECENTLY_ACTIVE" },
  );

  const unknownOwner = ownedRoute("codex-unknown-owner", "Unknown inventory");
  const unknownActivity = recordActivity(store, unknownOwner.route.run);
  const unknown = adapter({
    provider: "claude",
    nativeSessionId: "claude-unknown",
    workspaceRoot,
    env,
    store,
  });
  assert.throws(
    () =>
      unknown.continueTask({
        runId: unknownOwner.route.run.id,
        expectedRevision: unknownOwner.route.run.routeRevision,
        workspaceRoot,
      }),
    { code: "OWNER_WORK_UNKNOWN" },
  );

  const missingOwner = ownedRoute(
    "codex-missing-source",
    "Missing inventory source",
  );
  recordActivity(store, missingOwner.route.run);
  const missingSource = adapter({
    provider: "claude",
    nativeSessionId: "claude-missing-source",
    workspaceRoot,
    env,
    store,
    inspectOwnerWork: (input) =>
      hostEvidence(input, {
        sources: hostEvidence(input).sources.filter(
          (source) => source.id !== "odc-jobs",
        ),
      }),
  });
  assert.throws(
    () =>
      missingSource.continueTask({
        runId: missingOwner.route.run.id,
        expectedRevision: missingOwner.route.run.routeRevision,
        workspaceRoot,
      }),
    { code: "OWNER_WORK_UNKNOWN" },
  );

  const activeOwner = ownedRoute("codex-active-job", "Active background job");
  recordActivity(store, activeOwner.route.run);
  const activeJob = adapter({
    provider: "claude",
    nativeSessionId: "claude-active-job",
    workspaceRoot,
    env,
    store,
    inspectOwnerWork: (input) => {
      const evidence = hostEvidence(input);
      evidence.sources[1].activeWorkCount = 1;
      evidence.activeWorkCount = 1;
      return evidence;
    },
  });
  assert.throws(
    () =>
      activeJob.continueTask({
        runId: activeOwner.route.run.id,
        expectedRevision: activeOwner.route.run.routeRevision,
        workspaceRoot,
      }),
    { code: "OWNER_WORK_ACTIVE" },
  );
  assert.equal(
    store
      .getEvents(unknownOwner.route.run.id)
      .some((event) => event.id === unknownActivity.id),
    true,
  );
  store.close();
});

test("trusted host inspection blocker remains actionable and denies transfer", () => {
  const workspaceRoot = workspace();
  const env = { ...process.env, OTM_STORAGE: "json" };
  const { store } = createStore();
  const codex = adapter({
    provider: "codex",
    nativeSessionId: "codex-missing-manager-ledger",
    workspaceRoot,
    env,
    store,
  });
  const route = codex.startTask({
    workspaceRoot,
    goal: "Preserve host-evidence blocker",
    tasks: [reviewedAtomicTask("Host work gate")],
  });
  recordActivity(store, route.run);
  const claude = adapter({
    provider: "claude",
    nativeSessionId: "claude-missing-manager-ledger",
    workspaceRoot,
    env,
    store,
    inspectOwnerWork: (input) =>
      hostEvidence(input, {
        complete: false,
        blockers: ["ODC_JOB_JOIN_UNKNOWN"],
      }),
  });

  assert.throws(
    () =>
      claude.continueTask({
        runId: route.run.id,
        expectedRevision: route.run.routeRevision,
        workspaceRoot,
      }),
    { code: "ODC_JOB_JOIN_UNKNOWN" },
  );
  assert.equal(store.getRun(route.run.id).sessionId, route.run.sessionId);
  store.close();
});

test("activity arriving during host inspection invalidates the transfer CAS", () => {
  const workspaceRoot = workspace();
  const env = { ...process.env, OTM_STORAGE: "json" };
  const { store } = createStore();
  const codex = adapter({
    provider: "codex",
    nativeSessionId: "codex-race",
    workspaceRoot,
    env,
    store,
  });
  const route = codex.startTask({
    workspaceRoot,
    goal: "Fence late owner activity",
    tasks: [reviewedAtomicTask("Race gate")],
  });
  const activity = recordActivity(store, route.run);
  const claude = adapter({
    provider: "claude",
    nativeSessionId: "claude-race",
    workspaceRoot,
    env,
    store,
    inspectOwnerWork: (input) => {
      store.recordEvent({
        ...activity,
        id: "late-owner-activity",
        idempotencyKey: "late-owner-activity",
        createdAt: new Date().toISOString(),
      });
      return hostEvidence(input);
    },
  });
  assert.throws(
    () =>
      claude.continueTask({
        runId: route.run.id,
        expectedRevision: route.run.routeRevision,
        workspaceRoot,
      }),
    { code: "OWNER_ACTIVITY_CHANGED" },
  );
  assert.equal(store.getRun(route.run.id).sessionId, codex.session.sessionId);
  assert.equal(
    store.getCanonicalBinding(codex.session.sessionId).currentRunId,
    route.run.id,
  );
  assert.equal(
    store.getCanonicalBinding(claude.session.sessionId)?.currentRunId || null,
    null,
  );
  store.close();
});

test("continuation fails closed when the store cannot prove owner work evidence", () => {
  const workspaceRoot = workspace();
  const env = { ...process.env, OTM_STORAGE: "json" };
  const { store } = createStore();
  const owner = adapter({
    provider: "codex",
    nativeSessionId: "codex-truncated-history",
    workspaceRoot,
    env,
    store,
  });
  const route = owner.startTask({
    workspaceRoot,
    goal: "Prove complete owner history",
    tasks: [reviewedAtomicTask("History truncation gate")],
  });
  recordActivity(store, route.run);
  store.getOwnerWorkEvidence = () => null;
  const receiver = adapter({
    provider: "claude",
    nativeSessionId: "claude-truncated-history",
    workspaceRoot,
    env,
    store,
    inspectOwnerWork,
  });
  assert.throws(
    () =>
      receiver.continueTask({
        runId: route.run.id,
        expectedRevision: route.run.routeRevision,
        workspaceRoot,
      }),
    { code: "OWNER_WORK_UNKNOWN" },
  );
  assert.equal(store.getRun(route.run.id).sessionId, owner.session.sessionId);
  assert.equal(
    store.getCanonicalBinding(receiver.session.sessionId)?.currentRunId || null,
    null,
  );
  store.close();
});

test("Claude lifecycle hooks record observations and block unsafe Stop decisions", () => {
  const workspaceRoot = workspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-claude-hook-state-"),
  );
  const env = {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: stateDir,
    OTM_AUTO_SYNC_AGENTS: "0",
  };
  const sessionId = "claude-hook-integration-session";
  const started = runClaudeHook(
    hookPayload("SessionStart", sessionId, {
      cwd: workspaceRoot,
      source: "resume",
    }),
    { env, cwd: workspaceRoot },
  );
  assert.match(
    additionalContext(started),
    /shared canonical route|Shared OTM history|Task Manager is available/i,
  );
  const startCapability = capabilityFromHookResult(started);
  const startClaims = verifyClaudeSessionCapability(startCapability, { env });
  assert.equal(startClaims.workspaceRoot, workspaceRoot);
  assert.equal(
    startClaims.sessionId,
    createProviderSession({ provider: "claude", nativeSessionId: sessionId })
      .sessionId,
  );
  assert.equal(
    startCapability.includes(sessionId),
    false,
    "the bearer capability encrypts the native Claude session UUID",
  );

  const prompt = runClaudeHook(
    hookPayload("UserPromptSubmit", sessionId, {
      cwd: workspaceRoot,
      prompt: "status?",
    }),
    { env, cwd: workspaceRoot },
  );
  assert.ok(capabilityFromHookResult(prompt));
  assert.notEqual(
    capabilityFromHookResult(prompt),
    startCapability,
    "each prompt receives a fresh short-lived capability",
  );
  const store = new JsonStore({ stateDir: path.join(stateDir, "json") });
  store.init();
  const route = store
    .listRuns(null, 10)
    .find((run) => run.sessionId?.startsWith("otm-provider:claude:v1:"));
  assert.equal(
    route,
    undefined,
    "a simple status prompt does not create an OTM route",
  );

  const handBack = runClaudeHook(
    hookPayload("UserPromptSubmit", sessionId, {
      cwd: workspaceRoot,
      prompt:
        '<agent-message from="a1">\n[Subagent hand-back] The text below is the final report of a subagent. Implement and fix the config file, update docs; then add tests.\n</agent-message>',
    }),
    { env, cwd: workspaceRoot },
  );
  assert.ok(
    capabilityFromHookResult(handBack),
    "harness-only prompts still refresh the capability",
  );
  assert.equal(
    store
      .listRuns(null, 10)
      .find((run) => run.sessionId?.startsWith("otm-provider:claude:v1:")),
    undefined,
    "a subagent hand-back is not a user request and does not create a route",
  );

  const routeStarter = adapter({
    provider: "claude",
    nativeSessionId: sessionId,
    workspaceRoot,
    env,
    store,
  });
  const startedRoute = routeStarter.startTask({
    workspaceRoot,
    goal: "Claude hook work observation",
    tasks: [reviewedAtomicTask("Hook observation gate")],
  });

  runClaudeHook(
    hookPayload("PreToolUse", sessionId, {
      cwd: workspaceRoot,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_use_id: "toolu-test-1",
    }),
    { env, cwd: workspaceRoot },
  );
  runClaudeHook(
    hookPayload("PostToolUseFailure", sessionId, {
      cwd: workspaceRoot,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_use_id: "toolu-test-1",
      error: "test fixture failure",
      is_interrupt: false,
    }),
    { env, cwd: workspaceRoot },
  );
  runClaudeHook(
    hookPayload("SubagentStart", sessionId, {
      cwd: workspaceRoot,
      agent_id: "agent-test-1",
      agent_type: "Explore",
    }),
    { env, cwd: workspaceRoot },
  );
  runClaudeHook(
    hookPayload("SubagentStop", sessionId, {
      cwd: workspaceRoot,
      agent_id: "agent-test-1",
      agent_type: "Explore",
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot },
  );
  const loopGuard = runClaudeHook(
    hookPayload("Stop", sessionId, {
      cwd: workspaceRoot,
      stop_hook_active: true,
      background_tasks: [{ status: "running" }],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot },
  );
  assert.equal(loopGuard.decision, undefined);

  runClaudeHook(
    hookPayload("SubagentStart", sessionId, {
      cwd: workspaceRoot,
      agent_id: "agent-background-1",
      agent_type: "overtli-reviewer",
    }),
    { env, cwd: workspaceRoot },
  );
  const backgroundSubagentStop = runClaudeHook(
    hookPayload("Stop", sessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [{ id: "agent-background-1", status: "running" }],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot },
  );
  assert.equal(
    backgroundSubagentStop.decision,
    undefined,
    "a running background subagent is active work, not an unmatched receipt",
  );
  assert.equal(backgroundSubagentStop.continue, true);
  const subagentWithoutInventory = runClaudeHook(
    hookPayload("Stop", sessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot },
  );
  assert.equal(
    subagentWithoutInventory.decision,
    "block",
    "an open subagent receipt with no reported background work stays unknown",
  );
  runClaudeHook(
    hookPayload("SubagentStop", sessionId, {
      cwd: workspaceRoot,
      agent_id: "agent-background-1",
      agent_type: "overtli-reviewer",
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot },
  );

  runClaudeHook(
    hookPayload("PreToolUse", sessionId, {
      cwd: workspaceRoot,
      tool_name: "Bash",
      tool_input: { command: "long-running command" },
      tool_use_id: "toolu-cancelled-without-terminal-hook",
    }),
    { env, cwd: workspaceRoot },
  );
  const unmatchedToolStop = runClaudeHook(
    hookPayload("Stop", sessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot },
  );
  assert.equal(unmatchedToolStop.decision, "block");
  assert.match(unmatchedToolStop.reason, /unclassified|unmatched/i);

  // A PreToolUse denied by another hook never gets PostToolUse; Claude still
  // writes its tool_result to the (sub)agent transcript, which settles it.
  runClaudeHook(
    hookPayload("PreToolUse", sessionId, {
      cwd: workspaceRoot,
      tool_name: "Bash",
      tool_input: { command: "denied by guard" },
      tool_use_id: "toolu-denied-by-guard",
    }),
    { env, cwd: workspaceRoot },
  );
  const transcriptPath = path.join(stateDir, "main-session.jsonl");
  fs.writeFileSync(
    transcriptPath,
    '{"type":"user","message":{"content":"hi"}}\n',
  );
  fs.mkdirSync(path.join(stateDir, "main-session", "subagents"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(stateDir, "main-session", "subagents", "agent-x.jsonl"),
    [
      '{not json "tool_result"',
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: '{"nested":{"braces":"}"}} denied',
              is_error: true,
              tool_use_id: "toolu-denied-by-guard",
            },
          ],
        },
      }),
    ].join("\n"),
  );
  const transcriptStop = runClaudeHook(
    hookPayload("Stop", sessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      transcript_path: transcriptPath,
      background_tasks: [],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot },
  );
  assert.equal(
    transcriptStop.decision,
    "block",
    "the cancelled tool without a transcript result stays unmatched",
  );
  assert.ok(
    store
      .getEvents(startedRoute.run.id)
      .some(
        (event) =>
          event.eventType === "provider_host_work_settled" &&
          event.payload.workId === "tool:toolu-denied-by-guard" &&
          event.payload.settlementEvent === "transcript-tool-result",
      ),
    "guard-denied subagent tool settles from its transcript tool_result",
  );

  const activeBackground = runClaudeHook(
    hookPayload("Stop", sessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [{ id: "bg-1", status: "running" }],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot },
  );
  // The cancelled tool above is still an unmatched receipt, so this stays blocked.
  assert.equal(activeBackground.decision, "block");
  assert.match(activeBackground.reason, /unclassified background tasks/i);
  const missingInventory = runClaudeHook(
    hookPayload("Stop", sessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
    }),
    { env, cwd: workspaceRoot },
  );
  assert.equal(missingInventory.decision, "block");

  for (const [eventName, extra] of [
    [
      "PreCompact",
      { trigger: "manual", custom_instructions: "do not persist this" },
    ],
    [
      "PostCompact",
      { trigger: "auto", compact_summary: "do not import this summary" },
    ],
    ["SessionEnd", { reason: "resume" }],
  ]) {
    const response = runClaudeHook(
      hookPayload(eventName, sessionId, { cwd: workspaceRoot, ...extra }),
      { env, cwd: workspaceRoot },
    );
    assert.equal(response.continue, true);
    assert.equal(response.decision, undefined);
    assert.equal(response.hookSpecificOutput?.additionalContext, undefined);
  }
  const compactResume = runClaudeHook(
    hookPayload("SessionStart", sessionId, {
      cwd: workspaceRoot,
      source: "compact",
    }),
    { env, cwd: workspaceRoot },
  );
  const compactCapability = capabilityFromHookResult(compactResume);
  assert.equal(
    verifyClaudeSessionCapability(compactCapability, { env }).sessionId,
    startClaims.sessionId,
    "SessionStart after compaction refreshes the capability without changing session ownership",
  );
  const events = store.getEvents(startedRoute.run.id);
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "provider_host_work_started" &&
        event.payload.workId === "tool:toolu-test-1",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "provider_host_work_settled" &&
        event.payload.workId === "tool:toolu-test-1",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "provider_work_inventory" &&
        event.payload.unknownWorkCount === 1,
    ),
  );
  assert.ok(
    events.some((event) => event.eventType === "provider_session_ended"),
  );
  const checkpoint = events.find(
    (event) => event.eventType === "provider_checkpoint_recorded",
  );
  assert.ok(
    checkpoint,
    "PreCompact writes a shared OTM checkpoint before context compaction",
  );
  assert.equal(JSON.stringify(events).includes("do not persist this"), false);
  assert.equal(
    JSON.stringify(events).includes("do not import this summary"),
    false,
  );
  assert.equal(
    store.getRun(startedRoute.run.id).sessionId,
    startClaims.sessionId,
  );
  assert.equal(
    events.some(
      (event) =>
        event.eventType === "provider_host_work_started" &&
        event.payload.workId === "tool:toolu-cancelled-without-terminal-hook",
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.eventType === "provider_host_work_settled" &&
        event.payload.workId === "tool:toolu-cancelled-without-terminal-hook",
    ),
    false,
    "compaction preserves unfinished tool work for Stop and continuation checks",
  );

  const observerPath = path.join(stateDir, "host-bridge.mjs");
  const observerReceiptPath = path.join(stateDir, "claude-observer.json");
  fs.writeFileSync(
    observerPath,
    `import fs from "node:fs"; export function observeHostHook(context) { fs.writeFileSync(${JSON.stringify(observerReceiptPath)}, JSON.stringify({ provider: context.provider, nativeSessionId: context.nativeSessionId, providerSessionKey: context.providerSessionKey, runId: context.run?.id || null, eventName: context.eventName, toolName: context.payload.tool_name, jobId: context.payload.tool_response?.jobId })); }\n`,
  );
  const odcPost = runClaudeHook(
    hookPayload("PostToolUse", sessionId, {
      cwd: workspaceRoot,
      mcp_server: "overtli_desktop_commander",
      tool_name: "mcp__overtli_desktop_commander__process_job",
      tool_input: { job_id: "odc-job-real-1" },
      tool_response: { jobId: "odc-job-real-1", status: "running" },
      tool_use_id: "toolu-odc-real-1",
    }),
    { env, cwd: workspaceRoot, args: ["--host-evidence-module", observerPath] },
  );
  assert.equal(odcPost.continue, true);
  const observed = JSON.parse(fs.readFileSync(observerReceiptPath, "utf8"));
  assert.equal(observed.provider, "claude");
  assert.equal(observed.nativeSessionId, sessionId);
  assert.equal(
    observed.providerSessionKey,
    startedRoute.run.metadata.providerSession.providerSessionKey,
  );
  assert.equal(observed.runId, startedRoute.run.id);
  assert.equal(observed.eventName, "PostToolUse");
  assert.equal(
    observed.toolName,
    "mcp__overtli_desktop_commander__process_job",
  );
  assert.equal(observed.jobId, "odc-job-real-1");

  const finishSessionId = "claude-hook-complete-session";
  const finisher = adapter({
    provider: "claude",
    nativeSessionId: finishSessionId,
    workspaceRoot,
    env,
    store,
  });
  const finishRoute = finisher.startTask({
    workspaceRoot,
    goal: "Finalize after a passing Claude Stop audit",
    tasks: [reviewedAtomicTask("Stop-finalization gate")],
  });
  const finishTaskId = finishRoute.snapshot.tasks[0].id;
  finisher.markTaskActive({ runId: finishRoute.run.id, taskId: finishTaskId });
  finisher.recordProgress({
    runId: finishRoute.run.id,
    taskId: finishTaskId,
    internalStepIndex: 0,
    internalStepStatus: "done",
    message: "The Stop-finalization fixture is complete.",
  });
  finisher.completeTask({
    runId: finishRoute.run.id,
    taskId: finishTaskId,
    evidence: {
      kind: "test_result",
      summary: "The route has complete evidence.",
    },
  });
  const missingHostStop = runClaudeHook(
    hookPayload("Stop", finishSessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot },
  );
  assert.equal(missingHostStop.decision, "block");
  assert.match(missingHostStop.reason, /HOST_OBSERVER_UNAVAILABLE/);
  assert.equal(store.getRun(finishRoute.run.id).status, "ready_to_finalize");

  const incompleteObserver = writeClaudeStopObserver(stateDir, {
    coverageComplete: false,
  });
  const incompleteHostStop = runClaudeHook(
    hookPayload("Stop", finishSessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }),
    {
      env,
      cwd: workspaceRoot,
      args: ["--host-evidence-module", incompleteObserver],
    },
  );
  assert.equal(incompleteHostStop.decision, "block");
  assert.match(incompleteHostStop.reason, /ODC_OWNER_COVERAGE_UNKNOWN/);
  assert.equal(store.getRun(finishRoute.run.id).status, "ready_to_finalize");

  const activeJobObserver = writeClaudeStopObserver(stateDir, {
    activeWorkCount: 1,
  });
  const activeJobStop = runClaudeHook(
    hookPayload("Stop", finishSessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }),
    {
      env,
      cwd: workspaceRoot,
      args: ["--host-evidence-module", activeJobObserver],
    },
  );
  assert.equal(activeJobStop.decision, "block");
  assert.match(activeJobStop.reason, /1 active, 0 unknown/);
  assert.equal(store.getRun(finishRoute.run.id).status, "ready_to_finalize");

  const completeObserver = writeClaudeStopObserver(stateDir);
  const passedStop = runClaudeHook(
    hookPayload("Stop", finishSessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }),
    {
      env,
      cwd: workspaceRoot,
      args: ["--host-evidence-module", completeObserver],
    },
  );
  assert.match(
    additionalContext(passedStop),
    /saved the canonical route summary/i,
  );
  assert.equal(store.getRun(finishRoute.run.id).status, "cleared");
  assert.equal(store.listSummariesForRun(finishRoute.run.id).length, 1);
  assert.equal(finisher.snapshot({ write: false }).run, null);
  store.close();
});

test("Claude Stop finalizes settled owner work through the local host inspector", () => {
  const workspaceRoot = workspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-claude-real-host-stop-"),
  );
  const runtimeRoot = path.join(stateDir, "odc-runtime");
  const receiptRoot = path.join(stateDir, "host-evidence");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(receiptRoot, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, "process-jobs.json"),
    JSON.stringify({ schema: 1, jobs: [] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(runtimeRoot, "owned-processes.json"),
    JSON.stringify({ schema: 1, processes: [] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(runtimeRoot, "idempotency.json"),
    JSON.stringify([]),
    "utf8",
  );
  const configPath = path.join(stateDir, "host-evidence.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      projectRoots: [workspaceRoot],
      odcRuntimeRoot: runtimeRoot,
      receiptRoot,
    }),
    "utf8",
  );
  const env = {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: stateDir,
    OTM_HOST_EVIDENCE_CONFIG: configPath,
    OTM_AUTO_SYNC_AGENTS: "0",
  };
  const modulePath = path.join(
    packageRoot,
    "src",
    "core",
    "local-host-evidence.mjs",
  );
  const args = ["--host-evidence-module", modulePath];
  const sessionId = "claude-real-host-stop-session";
  const startup = runClaudeHook(
    hookPayload("SessionStart", sessionId, {
      cwd: workspaceRoot,
      source: "startup",
    }),
    { env, cwd: workspaceRoot, args },
  );
  assert.ok(capabilityFromHookResult(startup));

  const store = new JsonStore({ stateDir: path.join(stateDir, "json") });
  store.init();
  const owner = adapter({
    provider: "claude",
    nativeSessionId: sessionId,
    workspaceRoot,
    env,
    store,
  });
  const route = owner.startTask({
    workspaceRoot,
    goal: "Finalize after real owner-work inspection",
    tasks: [reviewedAtomicTask("Real host evidence Stop gate")],
  });
  const taskId = route.snapshot.tasks[0].id;
  owner.recordProgress({
    runId: route.run.id,
    taskId,
    internalStepIndex: 0,
    internalStepStatus: "done",
    message: "The route's verified substep is complete.",
  });
  owner.completeTask({
    runId: route.run.id,
    taskId,
    evidence: {
      kind: "test_result",
      summary: "The canonical route is complete before the host inspection.",
    },
  });

  // Claude re-invokes the session when its own background task finishes: the
  // turn may end, but the route is not finalized while that work is running.
  const waiting = runClaudeHook(
    hookPayload("Stop", sessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [{ id: "bg-1", status: "running" }],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot, args },
  );
  assert.equal(waiting.decision, undefined, JSON.stringify(waiting));
  assert.notEqual(store.getRun(route.run.id).status, "cleared");

  // Auto-compaction's summarizer stops without a SubagentStart.
  runClaudeHook(
    hookPayload("SubagentStop", sessionId, {
      cwd: workspaceRoot,
      agent_id: "compact-summarizer-1",
      agent_type: "compact",
      stop_hook_active: false,
    }),
    { env, cwd: workspaceRoot, args },
  );

  const stop = runClaudeHook(
    hookPayload("Stop", sessionId, {
      cwd: workspaceRoot,
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    }),
    { env, cwd: workspaceRoot, args },
  );
  assert.match(additionalContext(stop), /saved the canonical route summary/i);
  assert.equal(store.getRun(route.run.id).status, "cleared");
  const ownerDigest = crypto
    .createHash("sha256")
    .update(`claude\0${sessionId}`)
    .digest("hex");
  const coverage = JSON.parse(
    fs.readFileSync(
      path.join(receiptRoot, "owners", `${ownerDigest}.json`),
      "utf8",
    ),
  );
  assert.equal(coverage.schemaVersion, "otm.odc-owner-coverage.v1");
  assert.equal(coverage.provider, "claude");
  assert.equal(coverage.nativeSessionId, sessionId);
  assert.equal(owner.snapshot({ write: false }).run, null);
  owner.close();
  store.close();
});

test("existing Codex PostToolUse payload reaches the configured trusted host observer", async () => {
  const workspaceRoot = workspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-codex-observer-state-"),
  );
  const observerPath = path.join(stateDir, "host-bridge.mjs");
  const observerReceiptPath = path.join(stateDir, "codex-observer.json");
  fs.writeFileSync(
    observerPath,
    `import fs from "node:fs";
export function observeHostHook(context) {
  const record = { provider: context.provider, nativeSessionId: context.nativeSessionId, providerSessionKey: context.providerSessionKey, sessionId: context.sessionId, runId: context.run?.id || null, eventName: context.eventName, payloadSessionId: context.payload.session_id || null, toolName: context.payload.tool_name || null, action: context.payload.tool_input?.action || null, jobId: context.payload.tool_response?.jobId || null };
  fs.appendFileSync(${JSON.stringify(observerReceiptPath)}, JSON.stringify(record) + "\\n");
  return { observed: true, joined: Boolean(record.jobId), coverage: { complete: true, epochId: "fixture-epoch", pendingCount: 0, knownJobCount: 1, lastObservedAt: new Date().toISOString() }, dispatchAllowed: context.eventName !== "PreToolUse" || context.payload.tool_input?.action === "start", code: context.payload.tool_input?.action === "blocked" ? "ODC_INTENT_UNSUPPORTED" : null };
}\n`,
  );
  const nativeSessionId = "codex-post-tool-session";
  const env = {
    ...process.env,
    CODEX_THREAD_ID: nativeSessionId,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: stateDir,
    OTM_HOST_EVIDENCE_MODULE: observerPath,
    OTM_AUTO_SYNC_AGENTS: "0",
    OTM_DEDUPE_HOOKS: "0",
    OTM_TRACK_MCP_EVIDENCE: "0",
  };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const startupResult = await runHookScript("session-start", {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({
      cwd: workspaceRoot,
      session_id: nativeSessionId,
      hook_event_name: "SessionStart",
      source: "startup",
    }),
  });
  assert.equal(startupResult.continue, true);
  const route = manager.start({
    workspaceRoot,
    sessionId: nativeSessionId,
    providerContext: {
      ...createProviderSession({ provider: "codex", nativeSessionId }),
      nativeSessionId,
    },
    goal: "Observe exact Codex ODC job replies",
    tasks: [reviewedAtomicTask("ODC job observation gate")],
  });
  manager.close();

  const preInput = {
    cwd: workspaceRoot,
    session_id: nativeSessionId,
    hook_event_name: "PreToolUse",
    turn_id: "turn-codex-pre-1",
    tool_name: "mcp__desktop-commander__process_job",
    tool_input: { action: "blocked" },
    tool_use_id: "codex-tool-use-denied",
  };
  const deniedPre = await runHookScript("pre-tool-use", {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify(preInput),
  });
  assert.equal(
    deniedPre.hookSpecificOutput.permissionDecision,
    "deny",
    "unsupported ODC mutation must be blocked before dispatch",
  );
  const allowedPre = await runHookScript("pre-tool-use", {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({
      ...preInput,
      tool_input: { action: "start" },
      tool_use_id: "codex-tool-use-allowed",
    }),
  });
  assert.equal(allowedPre.hookSpecificOutput?.permissionDecision, undefined);

  const hookResult = await runHookScript("post-tool-use", {
    cwd: workspaceRoot,
    env,
    stdin: JSON.stringify({
      cwd: workspaceRoot,
      session_id: nativeSessionId,
      hook_event_name: "PostToolUse",
      tool_name: "mcp__desktop-commander__process_job",
      tool_input: { action: "start" },
      tool_response: { jobId: "odc-job-codex-1", status: "running" },
      tool_use_id: "codex-tool-use-allowed",
      turn_id: "turn-codex-1",
    }),
  });
  assert.equal(hookResult.continue, true);
  const hookObservations = fs
    .readFileSync(observerReceiptPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const startupObservation = hookObservations[0];
  assert.equal(startupObservation.eventName, "SessionStart");
  assert.equal(startupObservation.payloadSessionId, nativeSessionId);
  assert.equal(startupObservation.runId, null);
  assert.equal(startupObservation.sessionId, nativeSessionId);
  const observed = hookObservations.at(-1);
  assert.equal(observed.provider, "codex");
  assert.equal(observed.nativeSessionId, nativeSessionId);
  assert.equal(
    observed.providerSessionKey,
    route.run.metadata.providerSession.providerSessionKey,
  );
  assert.equal(observed.runId, route.run.id);
  assert.equal(observed.eventName, "PostToolUse");
  assert.equal(observed.toolName, "mcp__desktop-commander__process_job");
  assert.equal(observed.jobId, "odc-job-codex-1");
});

test("Codex PostToolUse loads the bundled observer when the trusted host config exists", async () => {
  const workspaceRoot = workspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-codex-default-observer-state-"),
  );
  const runtimeRoot = path.join(stateDir, "odc-runtime");
  const receiptRoot = path.join(stateDir, "host-evidence");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, "process-jobs.json"),
    JSON.stringify({ schema: 1, jobs: [] }),
  );
  fs.writeFileSync(
    path.join(runtimeRoot, "owned-processes.json"),
    JSON.stringify({ schema: 1, processes: [] }),
  );
  fs.writeFileSync(path.join(runtimeRoot, "idempotency.json"), "[]");
  const configPath = path.join(stateDir, "host-evidence.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      projectRoots: [workspaceRoot],
      odcRuntimeRoot: runtimeRoot,
      receiptRoot,
    }),
  );

  const nativeSessionId = "codex-default-observer-session";
  const env = {
    ...process.env,
    CODEX_THREAD_ID: nativeSessionId,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: stateDir,
    OTM_HOST_EVIDENCE_CONFIG: configPath,
    OTM_AUTO_SYNC_AGENTS: "0",
    OTM_DEDUPE_HOOKS: "0",
    OTM_TRACK_MCP_EVIDENCE: "0",
  };
  delete env.OTM_HOST_EVIDENCE_MODULE;
  const runCodexHook = (eventName, payload) => {
    const result = spawnSync(
      process.execPath,
      [path.join(packageRoot, "bin", "otm.mjs"), "hook", eventName],
      {
        cwd: workspaceRoot,
        env,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const startupResult = runCodexHook("session-start", {
    cwd: workspaceRoot,
    session_id: nativeSessionId,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  assert.equal(startupResult.continue, true);
  manager.start({
    workspaceRoot,
    sessionId: nativeSessionId,
    providerContext: {
      ...createProviderSession({ provider: "codex", nativeSessionId }),
      nativeSessionId,
    },
    goal: "Use default trusted Codex host observation",
    tasks: [reviewedAtomicTask("ODC join evidence gate")],
  });
  manager.close();

  const startedAt = new Date().toISOString();
  const jobId = "odc-job-default-1";
  const odcOwner = "odc-mcp-owner-1";
  const preTool = runCodexHook("pre-tool-use", {
    cwd: workspaceRoot,
    session_id: nativeSessionId,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__desktop-commander__process_job",
    tool_input: { action: "start" },
    tool_use_id: "codex-default-tool-use-1",
    turn_id: "turn-codex-default-1",
  });
  assert.equal(preTool.hookSpecificOutput?.permissionDecision, undefined);
  fs.writeFileSync(
    path.join(runtimeRoot, "process-jobs.json"),
    JSON.stringify({
      schema: 1,
      jobs: [
        {
          id: jobId,
          status: "running",
          ownerSessionId: odcOwner,
          startedAt,
        },
      ],
    }),
  );
  const hookResult = spawnSync(
    process.execPath,
    [path.join(packageRoot, "bin", "otm.mjs"), "hook", "post-tool-use"],
    {
      cwd: workspaceRoot,
      env,
      input: JSON.stringify({
        cwd: workspaceRoot,
        session_id: nativeSessionId,
        hook_event_name: "PostToolUse",
        tool_name: "mcp__desktop-commander__process_job",
        tool_input: { action: "start" },
        tool_response: {
          structuredContent: {
            jobId,
            ownerSessionId: odcOwner,
            status: "running",
            startedAt,
          },
        },
        tool_use_id: "codex-default-tool-use-1",
        turn_id: "turn-codex-default-1",
      }),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(hookResult.status, 0, hookResult.stderr);
  assert.equal(JSON.parse(hookResult.stdout).continue, true);

  const joinDir = path.join(receiptRoot, "joins");
  const joinPath = path.join(
    joinDir,
    crypto.createHash("sha256").update(jobId).digest("hex") + ".json",
  );
  assert.equal(fs.existsSync(joinPath), true);
  const receipt = JSON.parse(fs.readFileSync(joinPath, "utf8"));
  assert.equal(receipt.provider, "codex");
  assert.equal(receipt.nativeSessionId, nativeSessionId);
  assert.equal(receipt.jobId, jobId);
  assert.equal(receipt.odcOwnerSessionId, odcOwner);

  const unsupportedBatch = runCodexHook("pre-tool-use", {
    cwd: workspaceRoot,
    session_id: nativeSessionId,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__desktop-commander__system_write",
    tool_input: { operationId: "batch_execute", action: "run" },
    tool_use_id: "codex-default-batch-execute",
    turn_id: "turn-codex-default-batch-execute",
  });
  assert.equal(
    unsupportedBatch.hookSpecificOutput.permissionDecision,
    "deny",
    "recognized ODC batch work remains blocked until its route is fully covered",
  );
  assert.match(
    unsupportedBatch.hookSpecificOutput.permissionDecisionReason,
    /ODC_INTENT_UNSUPPORTED/,
  );
});

test("Claude settings installer merges the supported user file, is idempotent, and hash-checks rollback", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "otm-claude-home-"));
  const settingsPath = resolveClaudeUserSettingsPath({ homeDir });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const original = {
    theme: "dark",
    permissions: { allow: ["Read"] },
    mcpServers: { preserved: { command: "node", args: ["server.mjs"] } },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "user-hook", args: ["safe.js"] }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: "other-hook", args: ["prompt.js"] },
          ],
        },
      ],
    },
  };
  const originalBytes = Buffer.from(`${JSON.stringify(original, null, 2)}\n`);
  fs.writeFileSync(settingsPath, originalBytes);

  const dryRun = installClaudeHooks({ homeDir, packageRoot, dryRun: true });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(fs.readFileSync(settingsPath).equals(originalBytes), true);

  const observerPath = path.join(homeDir, "host-evidence.mjs");
  fs.writeFileSync(observerPath, "export function observeHostHook() {}\n");
  const canonicalStateDir = path.join(homeDir, "canonical-otm-state");
  const configuredEntries = buildClaudeHookEntries({
    packageRoot,
    hostEvidenceModulePath: observerPath,
    stateDir: canonicalStateDir,
    storage: "sqlite",
  });
  assert.deepEqual(configuredEntries.PostToolUse[0].hooks[0].args.slice(1), [
    "--host-evidence-module",
    observerPath,
    "--state-dir",
    canonicalStateDir,
    "--storage",
    "sqlite",
  ]);
  assert.equal(configuredEntries.PreToolUse[0].hooks[0].onFailure, "block");
  assert.equal(
    configuredEntries.UserPromptSubmit[0].hooks[0].onFailure,
    "block",
  );
  assert.equal(configuredEntries.Stop[0].hooks[0].onFailure, undefined);

  const installed = installClaudeHooks({
    homeDir,
    packageRoot,
    stateDir: canonicalStateDir,
    storage: "sqlite",
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.changed, true);
  assert.equal(installed.settingsPath, settingsPath);
  const merged = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(merged.permissions, original.permissions);
  assert.deepEqual(merged.mcpServers, original.mcpServers);
  assert.equal(merged.theme, "dark");
  assert.ok(
    merged.hooks.PreToolUse.some((group) =>
      group.hooks.some((handler) => handler.command === "user-hook"),
    ),
  );
  assert.equal(merged.hooks.SessionStart.length, 1);
  assert.equal(merged.hooks.PreCompact.length, 1);
  assert.equal(merged.hooks.PostCompact.length, 1);
  assert.equal(merged.hooks.SessionEnd.length, 1);
  const managed = merged.hooks.SessionStart[0].hooks[0];
  assert.equal(managed.command, process.execPath);
  assert.equal(managed.args[0], claudeHookScript);
  assert.deepEqual(installed.hookEvents, [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "PreCompact",
    "PostCompact",
    "SessionEnd",
  ]);

  const repeated = installClaudeHooks({
    homeDir,
    packageRoot,
    stateDir: canonicalStateDir,
    storage: "sqlite",
  });
  assert.equal(repeated.noOp, true);
  assert.equal(repeated.installedHash, installed.installedHash);
  const mismatch = rollbackClaudeHooks({
    homeDir,
    backupPath: installed.backupPath,
    backupHash: installed.backupHash,
    expectedCurrentHash: "0".repeat(64),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "CLAUDE_SETTINGS_HASH_MISMATCH");
  const rollback = rollbackClaudeHooks({
    homeDir,
    backupPath: installed.backupPath,
    backupHash: installed.backupHash,
    expectedCurrentHash: installed.installedHash,
  });
  assert.equal(rollback.ok, true);
  assert.equal(fs.readFileSync(settingsPath).equals(originalBytes), true);
});

test("Claude SessionStart injects only same-workspace active history", () => {
  const foreignRoot = workspace();
  const localRoot = workspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "otm-startup-workspace-filter-"));
  const env = {
    ...process.env,
    OTM_STATE_DIR: stateDir,
    OTM_STORAGE: "json",
    OTM_AUTO_SYNC_AGENTS: "0",
  };
  // The runtime's createStore uses <stateDir>/json, not <stateDir> itself.
  const store = createConfiguredStore({ env });
  const foreign = adapter({
    provider: "codex",
    nativeSessionId: "codex-foreign-startup-fixture",
    workspaceRoot: foreignRoot,
    env,
    store,
  });
  const local = adapter({
    provider: "codex",
    nativeSessionId: "codex-local-startup-fixture",
    workspaceRoot: localRoot,
    env,
    store,
  });
  const foreignRun = foreign.startTask({
    workspaceRoot: foreignRoot,
    goal: "FOREIGN_ROUTE_MUST_NOT_APPEAR",
    tasks: [reviewedAtomicTask("Foreign shared history gate")],
  });
  const localRun = local.startTask({
    workspaceRoot: localRoot,
    goal: "LOCAL_ROUTE_SHOULD_APPEAR",
    tasks: [reviewedAtomicTask("Local shared history gate")],
  });
  assert.equal(foreign.readSharedHistory({ scope: "all", limit: 10 }).runs.length, 2,
    "Explicit global shared-history browsing remains available");

  const result = runClaudeHook(
    hookPayload("SessionStart", "claude-local-startup-fixture", {
      cwd: localRoot,
      source: "startup",
    }),
    {
      env,
      cwd: localRoot,
      args: ["--state-dir", stateDir, "--storage", "json"],
    },
  );
  const context = additionalContext(result);
  assert.match(context, /LOCAL_ROUTE_SHOULD_APPEAR/);
  assert.doesNotMatch(context, /FOREIGN_ROUTE_MUST_NOT_APPEAR/);
  assert.match(context, new RegExp(localRun.run.id));
  assert.doesNotMatch(context, new RegExp(foreignRun.run.id));
  foreign.close();
  local.close();
});

test("Claude hook runtime args pin its capability and store to the shared backend", () => {
  const workspaceRoot = workspace();
  const inheritedStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-claude-hook-inherited-state-"),
  );
  const canonicalStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-claude-hook-canonical-state-"),
  );
  const env = {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: inheritedStateDir,
    OTM_AUTO_SYNC_AGENTS: "0",
  };
  const result = runClaudeHook(
    hookPayload("SessionStart", "claude-hook-shared-store-session", {
      cwd: workspaceRoot,
      source: "startup",
    }),
    {
      env,
      cwd: workspaceRoot,
      args: ["--state-dir", canonicalStateDir, "--storage", "json"],
    },
  );
  assert.equal(result.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(
    fs.existsSync(path.join(canonicalStateDir, "json", "state.json")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(inheritedStateDir, "json", "state.json")),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(canonicalStateDir, "claude-session-capability.key"),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(inheritedStateDir, "claude-session-capability.key"),
    ),
    false,
  );
});

test("Claude MCP stdio advances a canonical route with hook-issued capability and reads cross-provider history", async () => {
  const workspaceRoot = workspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-claude-mcp-state-"),
  );
  const runtimeRoot = path.join(stateDir, "odc-runtime");
  const receiptRoot = path.join(stateDir, "host-evidence");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, "process-jobs.json"),
    JSON.stringify({ schema: 1, jobs: [] }),
  );
  fs.writeFileSync(
    path.join(runtimeRoot, "owned-processes.json"),
    JSON.stringify({ schema: 1, processes: [] }),
  );
  fs.writeFileSync(path.join(runtimeRoot, "idempotency.json"), "[]");
  const hostEvidenceConfig = path.join(stateDir, "host-evidence.json");
  fs.writeFileSync(
    hostEvidenceConfig,
    JSON.stringify({
      schemaVersion: 1,
      projectRoots: [workspaceRoot],
      odcRuntimeRoot: runtimeRoot,
      receiptRoot,
    }),
  );
  const env = {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: stateDir,
    OTM_HOST_EVIDENCE_CONFIG: hostEvidenceConfig,
    OTM_AUTO_SYNC_AGENTS: "0",
  };

  const codex = adapter({
    provider: "codex",
    nativeSessionId: "codex-shared-history-source",
    workspaceRoot,
    env,
  });
  const codexRoute = codex.startTask({
    workspaceRoot,
    goal: "Readable across provider history",
    tasks: [reviewedAtomicTask("Shared history source gate")],
  });
  codex.close();

  const claudeSession = "claude-mcp-stdio-session";
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const hostEvidenceArgs = [
    "--host-evidence-module",
    path.join(packageRoot, "src", "core", "local-host-evidence.mjs"),
  ];
  const sessionStart = runClaudeHook(
    hookPayload("SessionStart", claudeSession, {
      cwd: workspaceRoot,
      source: "startup",
    }),
    { env, cwd: workspaceRoot, args: hostEvidenceArgs },
  );
  const startToken = capabilityFromHookResult(sessionStart);
  const prompt = runClaudeHook(
    hookPayload("UserPromptSubmit", claudeSession, {
      cwd: workspaceRoot,
      prompt: "Implement the Claude OTM shared history integration.",
    }),
    { env, cwd: workspaceRoot, args: hostEvidenceArgs },
  );
  const capability = capabilityFromHookResult(prompt);
  assert.notEqual(capability, startToken);
  assert.equal(capability.includes(claudeSession), false);
  assert.ok(CLAUDE_OTM_TOOLS.some((tool) => tool.name === "otm_history"));
  assert.ok(CLAUDE_OTM_TOOLS.some((tool) => tool.name === "otm_continue"));
  assert.equal(
    Object.hasOwn(
      CLAUDE_OTM_TOOLS.find((tool) => tool.name === "otm_history").inputSchema
        .properties,
      "sessionId",
    ),
    false,
  );

  const client = new Client({ name: "otm-claude-mcp-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageRoot, "bin", "otm-claude-mcp.mjs")],
    cwd: workspaceRoot,
    env,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of [
      "otm_snapshot",
      "otm_reconcile",
      "otm_progress",
      "otm_complete_task",
      "otm_audit_stop",
      "otm_checkpoint",
      "otm_history",
      "otm_continue",
    ]) {
      assert.ok(
        listed.tools.some((tool) => tool.name === name),
        `missing Claude OTM tool ${name}`,
      );
    }
    const invalid = await client.callTool({
      name: "otm_history",
      arguments: { sessionCapability: `${capability.slice(0, -1)}x` },
    });
    assert.equal(invalid.isError, true);

    const history = await client.callTool({
      name: "otm_history",
      arguments: { sessionCapability: capability },
    });
    assert.equal(history.structuredContent.ok, true);
    assert.ok(
      history.structuredContent.result.runs.some(
        (run) => run.id === codexRoute.run.id,
      ),
    );
    assert.equal(JSON.stringify(history).includes(capability), false);
    const hiddenWorkspace = await client.callTool({
      name: "otm_history",
      arguments: {
        sessionCapability: capability,
        workspaceRoot: "C:/other-project",
      },
    });
    assert.equal(hiddenWorkspace.isError, true);

    const store = createConfiguredStore({ env });
    const claudeRoute = store.listRuns(null, 20).find(
      (run) =>
        run.sessionId ===
        createProviderSession({
          provider: "claude",
          nativeSessionId: claudeSession,
        }).sessionId,
    );
    assert.ok(
      claudeRoute,
      "UserPromptSubmit creates the canonical Claude route before tools run",
    );
    assert.equal(
      claudeRoute.metadata.providerSession.nativeSessionId,
      claudeSession,
    );
    store.close();

    const sharedCodex = await client.callTool({
      name: "otm_snapshot",
      arguments: { sessionCapability: capability, runId: codexRoute.run.id },
    });
    assert.equal(
      sharedCodex.structuredContent.result.run.id,
      codexRoute.run.id,
    );
    assert.equal(
      JSON.stringify(sharedCodex).includes("codex-shared-history-source"),
      false,
    );

    const reconciled = await client.callTool({
      name: "otm_reconcile",
      arguments: {
        sessionCapability: capability,
        runId: claudeRoute.id,
        mode: "replace",
        prompt: "Model-reviewed Claude route plan for the shared task manager.",
        tasks: [reviewedAtomicTask("Claude MCP route control gate")],
      },
    });
    assert.equal(
      reconciled.structuredContent.ok,
      true,
      JSON.stringify(reconciled.structuredContent),
    );
    const taskId = reconciled.structuredContent.result.snapshot.tasks.find(
      (task) => task.status !== "superseded",
    ).id;

    const startedTask = await client.callTool({
      name: "otm_start_task",
      arguments: {
        sessionCapability: capability,
        runId: claudeRoute.id,
        taskId,
      },
    });
    assert.equal(
      startedTask.structuredContent.ok,
      true,
      JSON.stringify(startedTask),
    );
    const progressed = await client.callTool({
      name: "otm_progress",
      arguments: {
        sessionCapability: capability,
        runId: claudeRoute.id,
        taskId,
        internalStepIndex: 0,
        internalStepStatus: "done",
        message: "The reviewed Claude MCP route control work is complete.",
      },
    });
    assert.equal(progressed.structuredContent.ok, true);
    const completed = await client.callTool({
      name: "otm_complete_task",
      arguments: {
        sessionCapability: capability,
        runId: claudeRoute.id,
        taskId,
        evidence: {
          kind: "test_result",
          summary: "Claude stdio tools advanced this canonical route.",
        },
      },
    });
    assert.equal(completed.structuredContent.ok, true);
    const checkpoint = await client.callTool({
      name: "otm_checkpoint",
      arguments: {
        sessionCapability: capability,
        runId: claudeRoute.id,
        checkpointKey: "claude-mcp-checkpoint",
      },
    });
    assert.equal(checkpoint.structuredContent.ok, true);
    const audit = await client.callTool({
      name: "otm_audit_stop",
      arguments: { sessionCapability: capability, runId: claudeRoute.id },
    });
    assert.equal(audit.structuredContent.ok, true);
    assert.equal(audit.structuredContent.result.stopAllowed, true);
    await client.close();

    const stop = runClaudeHook(
      hookPayload("Stop", claudeSession, {
        cwd: workspaceRoot,
        stop_hook_active: false,
        background_tasks: [],
        session_crons: [],
      }),
      { env, cwd: workspaceRoot, args: hostEvidenceArgs },
    );
    assert.match(additionalContext(stop), /saved the canonical route summary/i);
    const afterStop = createConfiguredStore({ env });
    const saved = afterStop.listSummariesForRun(claudeRoute.id);
    assert.equal(saved.length, 1);
    const persisted = fs.readFileSync(
      path.join(stateDir, "json", "state.json"),
      "utf8",
    );
    assert.equal(
      persisted.includes(capability),
      false,
      "capability must never be persisted in canonical history",
    );
    afterStop.close();
  } finally {
    await client.close().catch(() => {});
  }
});

test("Claude capabilities reject expiry and tampering while keeping session identity opaque", () => {
  const workspaceRoot = workspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-claude-capability-test-"),
  );
  const env = { ...process.env, OTM_STORAGE: "json", OTM_STATE_DIR: stateDir };
  const nativeSessionId = "claude-capability-private-session";
  const capability = issueClaudeSessionCapability({
    nativeSessionId,
    workspaceRoot,
    env,
    now: 10_000,
  });
  assert.equal(capability.includes(nativeSessionId), false);
  const keyPath = capabilityKeyPath(env);
  if (process.platform === "win32") {
    const acl = spawnSync("icacls.exe", [keyPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(acl.status, 0);
    const who = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(who.status, 0);
    const currentIdentity =
      /^\s*"([^"]+)"\s*,\s*"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(who.stdout);
    const currentPrincipal = currentIdentity?.[1];
    const currentSid = currentIdentity?.[2];
    const [firstLine = "", ...remainingLines] = acl.stdout.split(/\r?\n/);
    assert.ok(firstLine.toLowerCase().startsWith(keyPath.toLowerCase()));
    const aclLines = [
      firstLine.slice(keyPath.length).trim(),
      ...remainingLines,
    ].filter((line) => line && !line.startsWith("Successfully processed"));
    const entries = aclLines.flatMap((line) => [
      ...line.matchAll(/^\s*([^\r\n]+?):\(([^)]*)\)\s*$/g),
    ]);
    assert.equal(
      entries.length,
      1,
      "the capability key has exactly one explicit ACL entry",
    );
    assert.ok(
      [currentPrincipal, currentSid].some(
        (expected) =>
          expected?.toLowerCase() === entries[0][1].trim().toLowerCase(),
      ),
    );
    assert.equal(entries[0][2], "F");
  } else {
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  }
  assert.equal(
    verifyClaudeSessionCapability(capability, { env, now: 11_000 })
      .nativeSessionId,
    nativeSessionId,
  );
  // Base64url permits distinct textual encodings of the same bytes unless
  // the representation is checked for canonical form before verification.
  const tokenParts = capability.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const tailIndex = alphabet.indexOf(tokenParts[2].at(-1));
  assert.ok(tailIndex >= 0);
  const aliasSignature = tokenParts[2].slice(0, -1) + alphabet[tailIndex ^ 1];
  assert.equal(
    Buffer.from(aliasSignature, "base64url").equals(Buffer.from(tokenParts[2], "base64url")),
    true,
    "the noncanonical variant decodes to identical signature bytes",
  );
  assert.throws(
    () => verifyClaudeSessionCapability(
      `${tokenParts[0]}.${tokenParts[1]}.${aliasSignature}`,
      { env, now: 11_000 },
    ),
    { code: "CLAUDE_SESSION_CAPABILITY_INVALID" },
  );
  assert.throws(
    () =>
      verifyClaudeSessionCapability(`${capability.slice(0, -1)}${capability.endsWith("x") ? "y" : "x"}`, {
        env,
        now: 11_000,
      }),
    {
      code: "CLAUDE_SESSION_CAPABILITY_INVALID",
    },
  );
  assert.throws(
    () =>
      verifyClaudeSessionCapability(capability, { env, now: 31 * 60 * 1000 }),
    {
      code: "CLAUDE_SESSION_CAPABILITY_INVALID",
    },
  );
});
