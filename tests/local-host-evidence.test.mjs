import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateContinuation } from "../src/core/continuation.mjs";
import { createProviderSession } from "../src/core/provider-session.mjs";
import {
  HOST_CONTINUATION_EVIDENCE_SCHEMA,
  HOST_HOOK_OBSERVATION_SCHEMA,
  inspectOwnerWork,
  observeHostHook,
} from "../src/core/local-host-evidence.mjs";

const FIXTURES = [];

test.afterEach(() => {
  const fixtures = FIXTURES.splice(0);
  if (fixtures[0]?.priorConfig === undefined) {
    delete process.env.OTM_HOST_EVIDENCE_CONFIG;
  } else {
    process.env.OTM_HOST_EVIDENCE_CONFIG = fixtures[0].priorConfig;
  }
  for (const fixture of fixtures.reverse()) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("retained native terminal receipt can satisfy fresh continuation inspection after idle threshold", () => {
  const fixture = createFixture();
  const now = Date.now();
  const boundAt = new Date(now - 17 * 60_000).toISOString();
  const activityAt = new Date(now - 16 * 60_000).toISOString();
  const proofAt = new Date(now - (15 * 60_000 + 5_000)).toISOString();
  const evidenceRef = writeNativeTask(fixture, {
    boundAt,
    proofAt,
    state: "completed",
  });
  assert.ok(Date.now() - Date.parse(proofAt) > 60_000);
  const input = inspectionInput(fixture, {
    activityAt,
  });

  const evidence = inspectOwnerWork(input);
  assert.equal(evidence.schemaVersion, HOST_CONTINUATION_EVIDENCE_SCHEMA);
  assert.equal(evidence.complete, true, JSON.stringify(evidence));
  assert.equal(evidence.activeWorkCount, 0);
  assert.equal(evidence.unknownWorkCount, 0);
  assert.deepEqual(evidence.sources.map((source) => source.id).sort(), [
    "native-broker",
    "odc-jobs",
  ]);
  assert.equal(
    evidence.sources.every((source) => source.evidenceRefs.length === 1),
    true,
  );
  const nativeReceipt = JSON.parse(
    fs.readFileSync(evidence.sources[0].evidenceRefs[0].path, "utf8"),
  );
  assert.equal(nativeReceipt.schemaVersion, "otm.host-source-observation.v1");
  assert.equal(
    nativeReceipt.sourcePredicates.taskEvidence[0].workerReceipts[0].path,
    path.resolve(fixture.projectRoot, evidenceRef),
  );
  assert.equal(
    nativeReceipt.sourcePredicates.taskEvidence[0].workerReceipts[0]
      .sourceObservedAt,
    proofAt,
  );
  assert.notEqual(
    nativeReceipt.sourcePredicates.taskEvidence[0].workerReceipts[0]
      .sourceObservedAt,
    evidence.observedAt,
  );
  const eligibility = evaluateContinuation({
    run: input.run,
    events: input.events,
    now: Date.now(),
    hostEvidence: evidence,
  });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.lastActivityEventId, input.activityEventId);
});

test("official process_job hook joins native identity to the exact ODC durable record", () => {
  const fixture = createFixture();
  const startedAt = new Date().toISOString();
  const jobId = "job-test-001";
  const odcOwner = "odc-transport-uuid";
  writeOdcStores(fixture, {
    jobs: [
      {
        id: jobId,
        status: "running",
        ownerSessionId: odcOwner,
        startedAt,
      },
      {
        id: "job-foreign-001",
        status: "running",
        ownerSessionId: "odc-foreign-transport",
        startedAt,
      },
    ],
    processes: [
      { id: jobId, pid: 24001, runId: "odc-run-01" },
      { id: "job-foreign-001", pid: "untrusted", runId: null },
    ],
  });
  const input = inspectionInput(fixture);
  const toolInput = {
    operationId: "process_job",
    action: "start",
    sessionCapability: "DO_NOT_PERSIST_CAPABILITY",
    jobId: "job-forged-999",
  };
  const pre = createHook(input, {
    eventName: "PreToolUse",
    toolInput,
    response: null,
  });
  const preResult = observeHostHook(pre);
  assert.equal(preResult.dispatchAllowed, true, JSON.stringify(preResult));
  const hook = createHook(input, {
    eventName: "PostToolUse",
    toolUseId: pre.payload.tool_use_id,
    toolInput,
    response: {
      structuredContent: {
        id: jobId,
        ownerSessionId: odcOwner,
        status: "running",
        startedAt,
        continuationToken: "DO_NOT_PERSIST_TOKEN",
      },
    },
  });
  const observed = observeHostHook(hook);
  assert.equal(observed.joined, true);
  assert.equal(observed.jobId, jobId);
  const join = JSON.parse(fs.readFileSync(observed.receiptPath, "utf8"));
  assert.equal(
    join.nativeSessionId,
    input.run.metadata.providerSession.nativeSessionId,
  );
  assert.equal(join.odcOwnerSessionId, odcOwner);
  assert.notEqual(join.nativeSessionId, join.odcOwnerSessionId);
  assert.equal(
    JSON.stringify(join).includes("DO_NOT_PERSIST_CAPABILITY"),
    false,
  );
  assert.equal(JSON.stringify(join).includes("DO_NOT_PERSIST_TOKEN"), false);
  assert.equal(JSON.stringify(join).includes("job-forged-999"), false);

  const active = inspectOwnerWork(input);
  assert.equal(active.complete, true, JSON.stringify(active));
  assert.equal(active.activeWorkCount, 1);
  assert.equal(active.unknownWorkCount, 0);
  const denied = evaluateContinuation({
    run: input.run,
    events: input.events,
    now: Date.now(),
    hostEvidence: active,
  });
  assert.equal(denied.eligible, false);

  writeOdcStores(fixture, {
    jobs: [
      {
        id: jobId,
        status: "completed",
        ownerSessionId: odcOwner,
        startedAt,
      },
      {
        id: "job-foreign-001",
        status: "running",
        ownerSessionId: "odc-foreign-transport",
        startedAt,
      },
    ],
    processes: [{ id: "job-foreign-001", pid: "untrusted", runId: null }],
  });
  const terminal = createHook(input, {
    eventName: "PostToolUse",
    toolInput: { operationId: "process_job", action: "status", jobId },
    response: {
      structuredContent: {
        id: jobId,
        ownerSessionId: odcOwner,
        status: "completed",
        startedAt,
      },
    },
  });
  assert.equal(observeHostHook(terminal).observed, true);
  const settled = inspectOwnerWork(input);
  assert.equal(settled.complete, true);
  assert.equal(settled.activeWorkCount, 0);
  assert.equal(settled.unknownWorkCount, 0);
});

test("bounded content text from the direct ODC tool response is also joined", () => {
  const fixture = createFixture();
  const startedAt = new Date().toISOString();
  const jobId = "job-test-003";
  const odcOwner = "odc-transport-uuid-03";
  writeOdcStores(fixture, {
    jobs: [
      {
        id: jobId,
        status: "running",
        ownerSessionId: odcOwner,
        startedAt,
      },
    ],
    processes: [],
  });
  const input = inspectionInput(fixture);
  const hook = createHook(input, {
    toolInput: { operationId: "process_job", action: "start" },
    response: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            process: {
              jobId,
              ownerSessionId: odcOwner,
              status: "running",
              startedAt,
            },
          }),
        },
      ],
    },
  });
  const pre = createHook(input, {
    eventName: "PreToolUse",
    toolInput: { operationId: "process_job", action: "start" },
    response: null,
  });
  pre.payload.tool_name = "mcp__desktop-commander__process_job";
  assert.equal(observeHostHook(pre).dispatchAllowed, true);
  hook.payload.tool_name = "mcp__desktop-commander__process_job";
  hook.payload.tool_use_id = pre.payload.tool_use_id;
  hook.payload.tool_input = pre.payload.tool_input;

  const observed = observeHostHook(hook);
  assert.equal(observed.joined, true);
  assert.equal(observed.jobId, jobId);
});

test("Codex hooks require official session and turn identity while checking optional aliases", () => {
  const fixture = createFixture();
  const input = inspectionInput(fixture);
  const ownerPath = path.join(
    fixture.receiptRoot,
    "owners",
    crypto
      .createHash("sha256")
      .update(`codex\0${input.ownerSession.nativeSessionId}`)
      .digest("hex") + ".json",
  );
  const ownerCoverage = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  assert.equal(ownerCoverage.schemaVersion, "otm.odc-owner-coverage.v1");
  assert.equal(ownerCoverage.epoch.eventName, "SessionStart");
  assert.equal(ownerCoverage.epoch.source, "startup");
  assert.equal(
    ownerCoverage.nativeSessionId,
    input.ownerSession.nativeSessionId,
  );
  const minimalStartup = createSessionStartHook(fixture, {
    provider: "codex",
    nativeSessionId: "codex-native-minimal-session-01",
    source: "startup",
  });
  delete minimalStartup.payload.thread_id;
  assert.equal(observeHostHook(minimalStartup).observed, true);

  const mismatchedInspection = inspectOwnerWork({
    ...input,
    ownerSession: {
      ...input.ownerSession,
      nativeSessionId: "different-codex-native-session",
    },
  });
  assert.equal(mismatchedInspection.complete, false);
  assert.ok(mismatchedInspection.unknownWorkCount > 0);
  const valid = createHook(input, {
    eventName: "PreToolUse",
    toolInput: { operationId: "process_job", action: "status" },
    response: {},
  });
  delete valid.payload.thread_id;
  valid.payload.turn_id = "turn-codex-identity-01";
  assert.equal(observeHostHook(valid).observed, true);

  for (const [index, mutate] of [
    (payload) => delete payload.session_id,
    (payload) => {
      payload.session_id = "another-codex-session";
    },
    (payload) => delete payload.turn_id,
    (payload) => {
      payload.turn_id = {};
    },
    (payload) => {
      payload.thread_id = "another-codex-session";
    },
    (payload) => {
      payload.conversation_id = "another-codex-session";
    },
  ].entries()) {
    const rejected = createHook(input, {
      toolInput: { operationId: "process_job" },
      response: {},
    });
    rejected.payload.turn_id = "turn-codex-identity-02";
    mutate(rejected.payload);
    const result = observeHostHook(rejected);
    assert.equal(
      result.observed,
      false,
      `identity mutation ${index}: ${JSON.stringify(result)}`,
    );
    assert.equal(result.code, "HOST_HOOK_IDENTITY_UNVERIFIED");
  }
});

test("only official startup opens an owner epoch and resume preserves it", () => {
  const fixture = createFixture();
  const nativeSessionId = "codex-lifecycle-session-01";
  const resume = createSessionStartHook(fixture, {
    provider: "codex",
    nativeSessionId,
    source: "resume",
  });
  const denied = observeHostHook(resume);
  assert.equal(denied.observed, false);
  assert.equal(denied.code, "ODC_OWNER_COVERAGE_LEGACY");

  const startup = createSessionStartHook(fixture, {
    provider: "codex",
    nativeSessionId,
    source: "startup",
  });
  const created = observeHostHook(startup);
  assert.equal(created.observed, true);
  const epochId = created.coverage.epochId;
  const laterResume = observeHostHook(resume);
  assert.equal(laterResume.observed, true);
  assert.equal(laterResume.coverage.epochId, epochId);
  assert.equal(laterResume.coverage.path, created.coverage.path);

  const journalBefore = fs.readFileSync(created.coverage.path);
  for (const eventName of [
    "UserPromptSubmit",
    "Stop",
    "PreCompact",
    "PostCompact",
    "SessionEnd",
  ]) {
    const lifecycle = {
      ...startup,
      eventName,
      payload: {
        hook_event_name: eventName,
        session_id: nativeSessionId,
      },
    };
    const result = observeHostHook(lifecycle);
    assert.equal(result.observed, true, JSON.stringify(result));
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.epochId, epochId);
  }
  const journalAfter = fs.readFileSync(created.coverage.path);
  assert.deepEqual(journalAfter, journalBefore);
});

test("forged tool arguments and mismatched response identity cannot create an ODC join", () => {
  const fixture = createFixture();
  const startedAt = new Date().toISOString();
  const jobId = "job-test-002";
  writeOdcStores(fixture, {
    jobs: [
      {
        id: jobId,
        status: "running",
        ownerSessionId: "odc-transport-uuid",
        startedAt,
      },
    ],
    processes: [{ id: jobId, pid: 24002, runId: "odc-run-02" }],
  });
  const input = inspectionInput(fixture);
  const hook = createHook(input, {
    eventName: "PreToolUse",
    toolInput: { operationId: "process_job", action: "start", jobId },
    response: null,
  });
  assert.equal(observeHostHook(hook).dispatchAllowed, true);
  const post = createHook(input, {
    toolInput: { operationId: "process_job", action: "start", jobId },
    response: {
      structuredContent: {
        id: jobId,
        ownerSessionId: "another-odc-owner",
        status: "running",
        startedAt,
      },
    },
  });

  post.payload.tool_use_id = hook.payload.tool_use_id;
  const observed = observeHostHook(post);
  assert.equal(observed.joined, false);
  assert.equal(observed.code, "ODC_JOB_JOIN_UNKNOWN");
  const evidence = inspectOwnerWork(input);
  assert.equal(evidence.complete, false);
  assert.ok(evidence.unknownWorkCount > 0);
  assert.equal(
    evidence.sources.find((source) => source.id === "odc-jobs").status,
    "unknown",
  );
});

test("paged creation responses leave owner coverage unknown even without an OTM route", () => {
  const fixture = createFixture();
  const input = inspectionInput(fixture);
  const toolInput = { operationId: "execution_provider", action: "dispatch" };
  const pre = createHook(input, {
    eventName: "PreToolUse",
    run: null,
    toolUseId: "tool-use-paged-create-01",
    toolInput,
    response: null,
  });
  assert.equal(observeHostHook(pre).dispatchAllowed, true);
  const post = createHook(input, {
    eventName: "PostToolUse",
    run: null,
    toolUseId: "tool-use-paged-create-01",
    toolInput,
    response: { structuredContent: { result_page: "opaque-page-token" } },
  });
  const result = observeHostHook(post);
  assert.equal(result.joined, false);
  assert.equal(result.code, "ODC_JOB_JOIN_UNKNOWN");
  assert.equal(result.coverage.complete, false);

  const evidence = inspectOwnerWork(input);
  assert.equal(evidence.complete, false);
  assert.ok(evidence.unknownWorkCount > 0);
  assert.equal(
    evidence.sources.find((source) => source.id === "odc-jobs").status,
    "unknown",
  );
});

test("unsupported mutating router action is denied before dispatch and retained as unknown", () => {
  const fixture = createFixture();
  const input = inspectionInput(fixture);
  const hook = createHook(input, {
    eventName: "PreToolUse",
    toolUseId: "tool-use-unsupported-route-01",
    toolInput: { operationId: "batch_execute", action: "start" },
  });
  const result = observeHostHook(hook);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.code, "ODC_INTENT_UNSUPPORTED");
  assert.equal(result.coverage.pendingCount, 1);
  const coverageText = fs.readFileSync(result.coverage.path, "utf8");
  assert.equal(coverageText.includes("operationId"), false);
  assert.equal(coverageText.includes("tool-use-unsupported-route-01"), true);

  const evidence = inspectOwnerWork(input);
  assert.equal(evidence.complete, false);
  assert.ok(evidence.unknownWorkCount > 0);
});

test("empty unregistered broker folders are excluded while registered missing state stays unknown", () => {
  const fixture = createFixture();
  const input = inspectionInput(fixture);
  const brokerRoot = path.join(
    fixture.projectRoot,
    ".codex",
    "overtli-orchestration",
  );
  const taskFolder = path.join(brokerRoot, "fusion-provider-install-20261020");
  fs.mkdirSync(taskFolder, { recursive: true });

  const empty = inspectOwnerWork(input);
  assert.equal(empty.complete, true, JSON.stringify(empty));
  const emptySource = JSON.parse(
    fs.readFileSync(
      empty.sources.find((source) => source.id === "native-broker")
        .evidenceRefs[0].path,
      "utf8",
    ),
  );
  const exclusion = emptySource.sourcePredicates.taskEvidence.find(
    (task) => task.taskId === "fusion-provider-install-20261020",
  );
  assert.equal(exclusion.scopeExclusion, true);
  assert.match(exclusion.predicate, /no canonical broker registration marker/);

  fs.writeFileSync(path.join(taskFolder, "writer.lock"), "active\n", "utf8");
  const registered = inspectOwnerWork(input);
  assert.equal(registered.complete, false);
  assert.ok(registered.unknownWorkCount > 0);
  assert.equal(
    registered.sources.find((source) => source.id === "native-broker").status,
    "unknown",
  );
});

test("provider-native SubagentStart and SubagentStop can prove the exact Codex worker terminal", () => {
  const fixture = createFixture();
  const input = inspectionInput(fixture);
  const childId = "codex-child-agent-01";
  writeNativeTask(fixture, {
    boundAt: new Date(Date.now() - 10_000).toISOString(),
    proofAt: new Date(Date.now() - 5_000).toISOString(),
    state: "completed",
    childSessionId: childId,
    omitProof: true,
  });
  for (const eventName of ["SubagentStart", "SubagentStop"]) {
    const hook = createHook(input, { eventName, agentId: childId });
    assert.equal(observeHostHook(hook).observed, true);
  }

  const evidence = inspectOwnerWork(input);
  assert.equal(evidence.complete, true, JSON.stringify(evidence));
  const native = JSON.parse(
    fs.readFileSync(
      evidence.sources.find((source) => source.id === "native-broker")
        .evidenceRefs[0].path,
      "utf8",
    ),
  );
  const proof = native.sourcePredicates.taskEvidence[0].workerReceipts[0];
  assert.equal(proof.source, "codex-native-hook");
  assert.equal(proof.childSessionId, childId);
  const ownerCoverage = JSON.parse(
    fs.readFileSync(
      ownerCoveragePath(fixture, "codex", input.ownerSession.nativeSessionId),
      "utf8",
    ),
  );
  assert.equal(
    proof.sourceObservedAt,
    ownerCoverage.subagents.find((row) => row.agentId === childId).stoppedAt,
  );
});

test("Claude native contract links transport owner to its exact task and active child", () => {
  const fixture = createFixture();
  const input = claudeInspectionInput(fixture);
  const native = input.ownerSession.nativeSessionId;
  const transportOwner = "odc-claude-transport-01";
  const brokerOwnerSessionId = `claude:${transportOwner}`;
  const taskId = `claude_${crypto.createHash("sha256").update(transportOwner).digest("hex").slice(0, 16)}_task-claude-raw-01`;
  const workerId = "claude-worker-01";
  const childId = "claude-child-agent-01";
  const taskDir = path.join(
    fixture.projectRoot,
    ".codex",
    "overtli-orchestration",
    taskId,
  );
  fs.mkdirSync(taskDir, { recursive: true });
  const state = {
    schemaVersion: 1,
    taskId,
    contract: {
      ownerSessionId: brokerOwnerSessionId,
      executionProvider: "claude",
      executionArchitecture: "native",
    },
    workers: {
      [workerId]: {
        id: workerId,
        package: { id: workerId, objective: "Active Claude child." },
        state: "RUNNING",
        attempt: 1,
        ownershipRetained: false,
        cancelRequested: false,
        steeringInvalidated: false,
        operationHistory: [
          {
            operationId: "native-bind:1",
            kind: "native-host-spawn",
            status: "running",
            target: childId,
            confirmed: true,
            recoveryStatus: "in-progress",
            at: new Date(Date.now() - 10_000).toISOString(),
          },
        ],
      },
    },
    externalWaits: {},
  };
  writeJson(path.join(taskDir, "state-v1.json"), state);

  const toolInput = {
    operationId: "provider_contract",
    action: "create",
    root: fixture.projectRoot,
    taskId: "task-claude-raw-01",
    sessionCapability: "DO_NOT_PERSIST_CAPABILITY",
  };
  const pre = createClaudeHook(input, {
    eventName: "PreToolUse",
    run: null,
    toolUseId: "tool-use-claude-contract-01",
    toolInput,
  });
  assert.equal(observeHostHook(pre).dispatchAllowed, true);
  const response = {
    structuredContent: {
      provider: "claude",
      taskId,
      continuationToken: "DO_NOT_PERSIST_TOKEN",
      snapshot: {
        taskId,
        contract: {
          ownerSessionId: brokerOwnerSessionId,
          executionProvider: "claude",
          executionArchitecture: "native",
        },
      },
    },
  };
  const post = createClaudeHook(input, {
    eventName: "PostToolUse",
    run: null,
    toolUseId: "tool-use-claude-contract-01",
    toolInput,
    response,
  });
  const observed = observeHostHook(post);
  assert.equal(observed.joined, true, JSON.stringify(observed));
  assert.equal(observed.taskId, taskId);
  const coverageText = fs.readFileSync(observed.coverage.path, "utf8");
  assert.equal(coverageText.includes("DO_NOT_PERSIST_CAPABILITY"), false);
  assert.equal(coverageText.includes("DO_NOT_PERSIST_TOKEN"), false);
  assert.equal(coverageText.includes(native), true);
  assert.equal(coverageText.includes(brokerOwnerSessionId), true);

  const evidence = inspectOwnerWork(input);
  assert.equal(evidence.complete, true, JSON.stringify(evidence));
  assert.equal(evidence.activeWorkCount, 1);
  assert.equal(evidence.unknownWorkCount, 0);

  state.workers[workerId].state = "COMPLETED";
  state.workers[workerId].ownershipRetained = false;
  writeJson(path.join(taskDir, "state-v1.json"), state);
  for (const eventName of ["SubagentStart", "SubagentStop"]) {
    const hook = createClaudeHook(input, { eventName, agentId: childId });
    assert.equal(observeHostHook(hook).observed, true);
  }
  const settled = inspectOwnerWork(input);
  assert.equal(settled.complete, true, JSON.stringify(settled));
  assert.equal(settled.activeWorkCount, 0);
  assert.equal(settled.unknownWorkCount, 0);
  const nativeReceipt = JSON.parse(
    fs.readFileSync(
      settled.sources.find((source) => source.id === "native-broker")
        .evidenceRefs[0].path,
      "utf8",
    ),
  );
  assert.equal(
    nativeReceipt.sourcePredicates.taskEvidence[0].workerReceipts[0].source,
    "claude-native-hook",
  );
});

test("native completion status without exact physical receipt or after material drift stays unknown", () => {
  const fixture = createFixture();
  writeNativeTask(fixture, {
    boundAt: new Date(Date.now() - 10_000).toISOString(),
    proofAt: new Date(Date.now() - 5_000).toISOString(),
    omitProof: true,
  });
  const input = inspectionInput(fixture);
  const missing = inspectOwnerWork(input);
  assert.equal(missing.complete, false);
  assert.ok(missing.unknownWorkCount > 0);

  writeNativeTask(fixture, {
    boundAt: new Date(Date.now() - 10_000).toISOString(),
    proofAt: new Date(Date.now() - 5_000).toISOString(),
    state: "completed",
    proofChildSessionId: "different-native-child-01",
  });
  const mismatched = inspectOwnerWork(input);
  assert.equal(mismatched.complete, false);
  assert.ok(mismatched.unknownWorkCount > 0);

  const changed = writeNativeTask(fixture, {
    boundAt: new Date(Date.now() - 10_000).toISOString(),
    proofAt: new Date(Date.now() - 5_000).toISOString(),
    state: "completed",
    mutateAfterSidecar: true,
  });
  assert.ok(changed);
  const drifted = inspectOwnerWork(input);
  assert.equal(drifted.complete, false);
  assert.ok(drifted.unknownWorkCount > 0);
  const source = JSON.parse(
    fs.readFileSync(
      drifted.sources.find((entry) => entry.id === "native-broker")
        .evidenceRefs[0].path,
      "utf8",
    ),
  );
  assert.equal(source.blockerCode, "NATIVE_PACKAGE_FINGERPRINT_MISMATCH");
});

test("relevant native broker ACTIVE and UNCERTAIN leases block even when expired", () => {
  const fixture = createFixture();
  writeNativeTask(fixture, {
    boundAt: new Date(Date.now() - 10_000).toISOString(),
    proofAt: new Date(Date.now() - 5_000).toISOString(),
    state: "completed",
  });
  const statePath = path.join(
    fixture.projectRoot,
    ".codex",
    "overtli-orchestration",
    "task-native-01",
    "state-v1.json",
  );
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.resourceRuntime.leases = {
    "lease-native-active": {
      status: "ACTIVE",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
    "lease-native-uncertain": {
      status: "UNCERTAIN",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  };
  writeJson(statePath, state);

  const evidence = inspectOwnerWork(inspectionInput(fixture));
  assert.equal(evidence.complete, true);
  assert.equal(evidence.activeWorkCount, 2);
  assert.equal(evidence.unknownWorkCount, 0);

  state.resourceRuntime.leases["lease-native-active"].status = "COMMITTED";
  state.resourceRuntime.leases["lease-native-uncertain"].status = "ABORTED";
  writeJson(statePath, state);
  const resolved = inspectOwnerWork(inspectionInput(fixture));
  assert.equal(resolved.complete, true, JSON.stringify(resolved));
  assert.equal(resolved.activeWorkCount, 0);
  assert.equal(resolved.unknownWorkCount, 0);
});

test("a declared resource graph without runtime lease inventory is unknown", () => {
  const fixture = createFixture();
  writeNativeTask(fixture, {
    boundAt: new Date(Date.now() - 10_000).toISOString(),
    proofAt: new Date(Date.now() - 5_000).toISOString(),
    state: "completed",
  });
  const statePath = path.join(
    fixture.projectRoot,
    ".codex",
    "overtli-orchestration",
    "task-native-01",
    "state-v1.json",
  );
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.resourceGraph = { resources: [] };
  delete state.resourceRuntime;
  writeJson(statePath, state);

  const evidence = inspectOwnerWork(inspectionInput(fixture));
  assert.equal(evidence.complete, false);
  assert.ok(evidence.unknownWorkCount > 0);
});

test("a foreign task lease does not block the current owner session", () => {
  const fixture = createFixture();
  writeNativeTask(fixture, {
    boundAt: new Date(Date.now() - 10_000).toISOString(),
    proofAt: new Date(Date.now() - 5_000).toISOString(),
    state: "completed",
  });
  writeNativeTask(fixture, {
    taskId: "task-foreign-01",
    workerId: "worker-foreign-01",
    ownerSessionId: "foreign-native-session-01",
    childSessionId: "foreign-child-session-01",
    boundAt: new Date(Date.now() - 10_000).toISOString(),
    proofAt: new Date(Date.now() - 5_000).toISOString(),
    state: "completed",
  });
  const statePath = path.join(
    fixture.projectRoot,
    ".codex",
    "overtli-orchestration",
    "task-foreign-01",
    "state-v1.json",
  );
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.resourceRuntime.leases = {
    "lease-foreign-active": {
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  writeJson(statePath, state);

  const evidence = inspectOwnerWork(inspectionInput(fixture));
  assert.equal(evidence.complete, true, JSON.stringify(evidence));
  assert.equal(evidence.activeWorkCount, 0);
  assert.equal(evidence.unknownWorkCount, 0);
});

test("read-only inspection records hashes and bounds from the actual local ODC inventory", () => {
  const fixture = createFixture();
  const localAppData = process.env.LOCALAPPDATA;
  assert.ok(localAppData);
  const actualRuntime = path.join(
    localAppData,
    "Overtli",
    "DesktopCommander",
    "runtime",
  );
  if (
    !fs.existsSync(path.join(actualRuntime, "process-jobs.json")) ||
    !fs.existsSync(path.join(actualRuntime, "owned-processes.json")) ||
    !fs.existsSync(path.join(actualRuntime, "idempotency.json"))
  ) {
    return;
  }
  const config = {
    ...fixture.config,
    odcRuntimeRoot: actualRuntime,
  };
  writeJson(fixture.configPath, config);

  const evidence = inspectOwnerWork(inspectionInput(fixture));
  const receipt = JSON.parse(
    fs.readFileSync(
      evidence.sources.find((source) => source.id === "odc-jobs")
        .evidenceRefs[0].path,
      "utf8",
    ),
  );
  const jobs = receipt.sourcePredicates.stores.find((store) =>
    store.path.endsWith("process-jobs.json"),
  );
  assert.ok(jobs);
  assert.match(jobs.sha256, /^[0-9a-f]{64}$/);
  assert.ok(jobs.count <= 200);
  assert.equal(jobs.cap, 200);
  assert.equal(jobs.truncated, jobs.count >= 200);
  assert.deepEqual(evidence.sources.map((source) => source.id).sort(), [
    "native-broker",
    "odc-jobs",
  ]);
});

function createFixture() {
  const priorConfig = process.env.OTM_HOST_EVIDENCE_CONFIG;
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-local-host-evidence-"),
  );
  const projectRoot = path.join(root, "project");
  const runtimeRoot = path.join(root, "odc-runtime");
  const receiptRoot = path.join(root, "evidence");
  for (const directory of [projectRoot, runtimeRoot, receiptRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  writeOdcStores({ runtimeRoot }, { jobs: [], processes: [] });

  const configPath = path.join(root, "host-evidence.json");
  const config = {
    schemaVersion: 1,
    projectRoots: [projectRoot],
    odcRuntimeRoot: runtimeRoot,
    receiptRoot,
  };
  writeJson(configPath, config);
  process.env.OTM_HOST_EVIDENCE_CONFIG = configPath;
  const fixture = {
    root,
    projectRoot,
    runtimeRoot,
    receiptRoot,
    configPath,
    config,
    priorConfig,
  };
  FIXTURES.push(fixture);
  return fixture;
}

function inspectionInput(fixture, { activityAt } = {}) {
  const nativeSessionId = "codex-native-session-01";
  const providerSessionKey =
    "codex:" +
    crypto
      .createHash("sha256")
      .update(`overtli-task-manager\0codex\0${nativeSessionId}`)
      .digest("hex");
  const run = {
    id: "run-ci14-01",
    sessionId: nativeSessionId,
    routeRevision: 7,
    workspaceRoot: fixture.projectRoot,
    status: "active",
    metadata: {
      providerSession: {
        provider: "codex",
        providerSessionKey,
        nativeSessionId,
      },
    },
  };
  const event = {
    id: "activity-event-01",
    eventType: "provider_session_activity",
    createdAt: activityAt || new Date(Date.now() - 16 * 60_000).toISOString(),
    payload: {
      ownerSessionId: run.sessionId,
      providerSessionKey,
    },
  };
  const input = {
    schemaVersion: HOST_CONTINUATION_EVIDENCE_SCHEMA,
    run,
    runId: run.id,
    workspaceRoot: run.workspaceRoot,
    routeRevision: run.routeRevision,
    ownerSession: run.metadata.providerSession,
    activityAt: event.createdAt,
    activityEventId: event.id,
    requiredSources: ["native-broker", "odc-jobs"],
    events: [event],
  };
  const startup = observeHostHook({
    schemaVersion: HOST_HOOK_OBSERVATION_SCHEMA,
    provider: "codex",
    eventName: "SessionStart",
    payload: {
      hook_event_name: "SessionStart",
      session_id: nativeSessionId,
      thread_id: nativeSessionId,
      source: "startup",
    },
    workspaceRoot: fixture.projectRoot,
    nativeSessionId,
    providerSessionKey,
    sessionId: nativeSessionId,
    routeRevision: null,
    run: null,
  });
  assert.equal(startup.observed, true, JSON.stringify(startup));
  return input;
}

function claudeInspectionInput(fixture) {
  const nativeSessionId = "claude-native-session-01";
  const provider = createProviderSession({
    provider: "claude",
    nativeSessionId,
  });
  const providerSession = {
    provider: "claude",
    providerSessionKey: provider.providerSessionKey,
    nativeSessionId,
  };
  const run = {
    id: "run-claude-ci14-01",
    sessionId: provider.sessionId,
    routeRevision: 3,
    workspaceRoot: fixture.projectRoot,
    status: "active",
    metadata: { providerSession },
  };
  const event = {
    id: "activity-event-claude-01",
    eventType: "provider_session_activity",
    createdAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    payload: {
      ownerSessionId: run.sessionId,
      providerSessionKey: providerSession.providerSessionKey,
    },
  };
  const input = {
    schemaVersion: HOST_CONTINUATION_EVIDENCE_SCHEMA,
    run,
    runId: run.id,
    workspaceRoot: run.workspaceRoot,
    routeRevision: run.routeRevision,
    ownerSession: providerSession,
    activityAt: event.createdAt,
    activityEventId: event.id,
    requiredSources: ["native-broker", "odc-jobs"],
    events: [event],
  };
  const startup = observeHostHook({
    schemaVersion: HOST_HOOK_OBSERVATION_SCHEMA,
    provider: "claude",
    eventName: "SessionStart",
    payload: {
      hook_event_name: "SessionStart",
      session_id: nativeSessionId,
      source: "startup",
    },
    workspaceRoot: fixture.projectRoot,
    nativeSessionId,
    providerSessionKey: provider.providerSessionKey,
    sessionId: provider.sessionId,
    routeRevision: null,
    run: null,
  });
  assert.equal(startup.observed, true, JSON.stringify(startup));
  return input;
}

function createSessionStartHook(
  fixture,
  { provider, nativeSessionId, source },
) {
  const derived = createProviderSession({ provider, nativeSessionId });
  return {
    schemaVersion: HOST_HOOK_OBSERVATION_SCHEMA,
    provider,
    eventName: "SessionStart",
    workspaceRoot: fixture.projectRoot,
    nativeSessionId,
    providerSessionKey: derived.providerSessionKey,
    sessionId: derived.sessionId,
    routeRevision: null,
    run: null,
    payload: {
      hook_event_name: "SessionStart",
      session_id: nativeSessionId,
      ...(provider === "codex" ? { thread_id: nativeSessionId } : {}),
      source,
    },
  };
}

function createHook(
  input,
  {
    eventName = "PostToolUse",
    toolInput,
    response,
    toolUseId = "tool-use-ci14-01",
    agentId,
    run = input.run,
  },
) {
  const nativeSessionId = input.run.metadata.providerSession.nativeSessionId;
  return {
    schemaVersion: HOST_HOOK_OBSERVATION_SCHEMA,
    provider: input.run.metadata.providerSession.provider,
    eventName,
    nativeSessionId,
    providerSessionKey: input.run.metadata.providerSession.providerSessionKey,
    sessionId: input.run.sessionId,
    routeRevision: run?.routeRevision ?? null,
    workspaceRoot: input.run.workspaceRoot,
    run,
    payload: {
      hook_event_name: eventName,
      session_id: nativeSessionId,
      thread_id: nativeSessionId,
      turn_id: "turn-codex-observation-01",
      tool_use_id: toolUseId,
      tool_name: "mcp__desktop-commander__system_write",
      tool_input: toolInput,
      tool_response: response,
      ...(agentId ? { agent_id: agentId } : {}),
    },
  };
}

function createClaudeHook(
  input,
  {
    eventName,
    toolInput,
    response,
    toolUseId = "tool-use-claude-ci14-01",
    agentId,
    run = input.run,
  },
) {
  const providerSession = input.run.metadata.providerSession;
  return {
    schemaVersion: HOST_HOOK_OBSERVATION_SCHEMA,
    provider: "claude",
    eventName,
    nativeSessionId: providerSession.nativeSessionId,
    providerSessionKey: providerSession.providerSessionKey,
    sessionId: input.run.sessionId,
    routeRevision: run?.routeRevision ?? null,
    workspaceRoot: input.run.workspaceRoot,
    run,
    payload: {
      hook_event_name: eventName,
      session_id: providerSession.nativeSessionId,
      tool_use_id: toolUseId,
      tool_name: "mcp__desktop-commander__system_write",
      tool_input: toolInput,
      tool_response: response,
      ...(agentId ? { agent_id: agentId } : {}),
    },
  };
}

function ownerCoveragePath(fixture, provider, nativeSessionId) {
  const ownerHash = crypto
    .createHash("sha256")
    .update(`${provider}\0${nativeSessionId}`)
    .digest("hex");
  return path.join(fixture.receiptRoot, "owners", `${ownerHash}.json`);
}

function writeOdcStores(fixture, { jobs, processes }) {
  writeJson(path.join(fixture.runtimeRoot, "process-jobs.json"), {
    schema: 1,
    jobs,
  });
  writeJson(path.join(fixture.runtimeRoot, "owned-processes.json"), {
    schema: 1,
    processes,
  });
  writeJson(path.join(fixture.runtimeRoot, "idempotency.json"), []);
}

function writeNativeTask(fixture, options) {
  const taskId = options.taskId || "task-native-01";
  const workerId = options.workerId || "worker-native-01";
  const childSessionId = options.childSessionId || "child-native-session-01";
  const ownerSessionId =
    options.ownerSessionId ||
    inspectionInput(fixture).run.metadata.providerSession.nativeSessionId;
  const taskRoot = path.join(
    fixture.projectRoot,
    ".codex",
    "overtli-orchestration",
    taskId,
  );
  const workerRoot = path.join(taskRoot, "workers", workerId);
  fs.mkdirSync(workerRoot, { recursive: true });
  const packageRecord = {
    id: workerId,
    role: "implementer",
    objective: "Complete one bounded local evidence producer.",
  };
  const evidenceRef = path
    .join(
      ".codex",
      "overtli-orchestration",
      taskId,
      "workers",
      workerId,
      "host-terminal.json",
    )
    .split(path.sep)
    .join("/");
  if (!options.omitProof) {
    writeJson(path.join(workerRoot, "host-terminal.json"), {
      source: "codex-native-host",
      task_id: taskId,
      worker_id: workerId,
      child_session_id: options.proofChildSessionId || childSessionId,
      attempt: 1,
      state: options.state || "completed",
      observed_at: options.proofAt,
    });
  }
  const worker = {
    id: workerId,
    package: packageRecord,
    state: "COMPLETED",
    attempt: 1,
    ownershipRetained: false,
    cancelRequested: false,
    steeringInvalidated: false,
    operationHistory: [
      {
        operationId: "native-bind:1",
        kind: "native-host-spawn",
        status: "running",
        target: childSessionId,
        confirmed: true,
        recoveryStatus: "in-progress",
        at: options.boundAt,
      },
    ],
    packet: { evidence_refs: [evidenceRef] },
  };
  const currentWorker = options.mutateAfterSidecar
    ? {
        ...worker,
        package: { ...packageRecord, objective: "Materially changed package." },
      }
    : worker;
  const state = {
    schemaVersion: 1,
    taskId,
    contract: { ownerSessionId },
    workers: { [workerId]: currentWorker },
    externalWaits: {},
    ...(options.omitResourceRuntime
      ? {}
      : { resourceRuntime: { leases: options.resourceLeases || {} } }),
  };
  writeJson(path.join(taskRoot, "state-v1.json"), state);
  const sidecar = {
    schema: 1,
    task_id: taskId,
    root_session_id: ownerSessionId,
    workers: {
      [workerId]: {
        package_fingerprint: crypto
          .createHash("sha256")
          .update(JSON.stringify(packageRecord))
          .digest("hex"),
        route: { model: "gpt-6-luna", effort: "xhigh" },
        result: {
          attempt: 1,
          status: "completed",
          evidence_refs: [evidenceRef],
        },
      },
    },
  };
  writeJson(path.join(taskRoot, "native-routing.json"), sidecar);
  return evidenceRef;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value) + "\n", "utf8");
}
