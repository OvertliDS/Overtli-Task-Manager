import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProviderSession } from "./provider-session.mjs";

export const HOST_HOOK_OBSERVATION_SCHEMA = "otm.host-hook-observation.v1";
export const HOST_CONTINUATION_EVIDENCE_SCHEMA =
  "otm.host-continuation-evidence.v1";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_NATIVE_STATE_BYTES = 4 * 1024 * 1024;
const MAX_ROUTING_BYTES = 1024 * 1024;
const MAX_HOST_RECEIPT_BYTES = 256 * 1024;
const MAX_ODC_STORE_BYTES = 4 * 1024 * 1024;
const MAX_ODC_PROCESS_BYTES = 256 * 1024;
const MAX_ODC_JOBS = 200;
const MAX_IDEMPOTENCY_ROWS = 500;
const MAX_NATIVE_TASKS_PER_ROOT = 256;
const MAX_NATIVE_TASKS_TOTAL = 128;
const MAX_NATIVE_WORKERS_PER_TASK = 64;
const MAX_NATIVE_OPS_PER_WORKER = 128;
const MAX_NATIVE_ROOTS = 32;
const MAX_JOIN_RECEIPTS = 512;
const MAX_OWNER_COVERAGE_RECORDS = 4096;
const MAX_OWNER_COVERAGE_ENTRIES = 512;
const MAX_OWNER_COVERAGE_BYTES = 4 * 1024 * 1024;
const MAX_INSPECTION_RECEIPTS = 4096;
const MAX_SOURCE_RECEIPT_BYTES = 4 * 1024 * 1024;
const ACTIVE_STATUSES = new Set([
  "active",
  "queued",
  "starting",
  "running",
  "working",
  "pending",
  "requested",
  "in-progress",
  "waiting",
  "scheduled",
  "dispatched",
  "progress",
]);
const TERMINAL_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "failed",
  "errored",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "interrupted",
  "settled",
  "terminal",
  "dropped",
  "superseded",
  "rejected",
  "timed-out",
  "idle-expired",
]);
const HOST_TERMINAL_STATES = new Set([
  "completed",
  "stopped",
  "interrupted",
  "failed",
  "errored",
  "cancelled",
  "canceled",
]);
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{7,127}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}$/;
const ODC_TOOLS = new Set([
  "process_job",
  "process_run",
  "script_job",
  "script_run",
  "execution_provider",
  "agent_delegate",
  "orchestration",
  "youtube_media",
  "audio_analysis",
  "media_proxy_pool",
  "provider_contract",
  "batch_execute",
]);
const ODC_TOOL_PREFIXES = [
  "mcp__desktop-commander__",
  "mcp__desktop_commander__",
  "mcp__overtli_desktop_commander__",
];

/**
 * Inspect only the canonical route owner and trusted, bounded local sources.
 * All evidence supplied by the host is re-read from its durable local store.
 */
export function inspectOwnerWork(input = {}) {
  const startedAt = new Date().toISOString();
  const context = validateInspectionInput(input);
  if (!context.ok) return failedInspection(input, startedAt, context.code);

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return failedInspection(input, startedAt, safeCode(error));
  }
  let projectRoots;
  try {
    projectRoots = trustedProjectRoots(config, context.run);
    for (const task of readOwnerCoverage(config.receiptRoot, context.owner)
      .record?.nativeTasks || []) {
      if (projectRoots.some((root) => isWithinRoot(task.projectRoot, root))) {
        projectRoots.push(task.projectRoot);
      }
    }
    projectRoots = [...new Set(projectRoots)];
    if (projectRoots.length > MAX_NATIVE_ROOTS) {
      throw errorCode("PROJECT_ROOT_LIMIT_EXCEEDED");
    }
    assertReceiptRootDisjoint(config, projectRoots);
  } catch (error) {
    return failedInspection(input, startedAt, safeCode(error));
  }

  const now = Date.now();
  const observedAt = new Date(now).toISOString();
  const ownerCoverage = readOwnerCoverage(config.receiptRoot, context.owner);
  const sourceResults = [];
  const blockers = [];

  const native = inspectNativeBroker({
    roots: projectRoots,
    owner: context.owner,
    ownerCoverage,
    observedAt,
    now,
  });
  sourceResults.push(native);

  const odc = inspectOdc({
    runtimeRoot: config.odcRuntimeRoot,
    receiptRoot: config.receiptRoot,
    owner: context.owner,
    ownerCoverage,
    observedAt,
  });
  sourceResults.push(odc);

  const latestOwnerCoverage = readOwnerCoverage(
    config.receiptRoot,
    context.owner,
  );
  if (
    latestOwnerCoverage.complete !== ownerCoverage.complete ||
    latestOwnerCoverage.sha256 !== ownerCoverage.sha256 ||
    latestOwnerCoverage.code !== ownerCoverage.code
  ) {
    for (const source of sourceResults) {
      source.inventoryComplete = false;
      source.unknownWorkCount += 1;
      source.code = "ODC_OWNER_COVERAGE_CHANGED_DURING_INSPECTION";
    }
  }

  const receipts = persistSourceReceipts({
    sourceResults,
    receiptRoot: config.receiptRoot,
    owner: context.owner,
    run: context.run,
    activityAt: context.activityAt,
    activityEventId: context.activityEventId,
    observedAt,
  });
  if (!receipts.ok) blockers.push(receipts.code);

  for (const source of sourceResults) {
    if (!source.inventoryComplete)
      blockers.push(source.code || "SOURCE_UNKNOWN");
  }

  const complete = blockers.length === 0 && receipts.ok;
  const sources = sourceResults.map((source, index) => ({
    id: source.id,
    status: source.inventoryComplete ? "complete" : "unknown",
    ownerSessionId: context.owner.nativeSessionId,
    observedAt,
    activeWorkCount: source.activeWorkCount,
    unknownWorkCount:
      source.unknownWorkCount + (source.inventoryComplete ? 0 : 1),
    evidenceRefs: receipts.ok ? [receipts.refs[index]] : [],
  }));
  const activeWorkCount = sources.reduce(
    (sum, source) => sum + source.activeWorkCount,
    0,
  );
  const unknownWorkCount = sources.reduce(
    (sum, source) => sum + source.unknownWorkCount,
    0,
  );

  return {
    schemaVersion: HOST_CONTINUATION_EVIDENCE_SCHEMA,
    complete,
    runId: context.run.id,
    routeRevision: context.run.routeRevision,
    lastActivityAt: context.activityAt,
    activityEventId: context.activityEventId,
    owner: context.owner,
    observedAt,
    activeWorkCount,
    unknownWorkCount,
    sources,
    blockers: blockers.slice(0, 24),
  };
}

/**
 * Record a native-session to ODC job join only from an official post-tool hook
 * and a bounded response that matches the current durable ODC job record.
 */
export function observeHostHook(input = {}) {
  const now = new Date().toISOString();
  const base = validateHookInput(input);
  if (!base.ok) {
    return hookResult({
      observed: false,
      dispatchAllowed: false,
      code: base.code,
      ...(base.mismatch ? { mismatch: base.mismatch } : {}),
    });
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return hookResult({
      observed: false,
      code: safeCode(error),
      dispatchAllowed: false,
    });
  }

  const owner = {
    provider: base.provider,
    providerSessionKey: base.providerSessionKey,
    nativeSessionId: base.nativeSessionId,
  };
  if (base.eventName === "SessionStart") {
    return observeOwnerSessionStart({
      config,
      base,
      owner,
      now,
    });
  }

  const current = readOwnerCoverage(config.receiptRoot, owner);
  if (base.eventName === "SubagentStart" || base.eventName === "SubagentStop") {
    return observeNativeSubagent({ config, base, owner, current, now });
  }
  const action = classifyHostTool(base);
  if (!action) {
    return hookResult({
      observed: current.complete,
      coverage: current,
      dispatchAllowed: true,
      code: current.code || null,
    });
  }
  if (!current.complete || !current.record) {
    return hookResult({
      observed: false,
      coverage: current,
      dispatchAllowed: base.eventName === "PreToolUse" ? false : true,
      code: current.code || "ODC_OWNER_COVERAGE_UNKNOWN",
    });
  }

  if (base.eventName === "PreToolUse") {
    if (action.kind === "readonly") {
      return hookResult({ observed: true, coverage: current });
    }
    if (action.kind === "native-control") {
      const authorized = authorizeNativeTaskControl({
        config,
        base,
        owner,
        action,
        current,
      });
      if (!authorized.ok) {
        const recorded = appendOwnerIntent({
          receiptRoot: config.receiptRoot,
          owner,
          current,
          action: { ...action, kind: "unsupported" },
          payload: base.payload,
          observedAt: now,
          unresolved: true,
        });
        return hookResult({
          observed: false,
          coverage: recorded.coverage,
          dispatchAllowed: false,
          code: authorized.code,
        });
      }
    }
    if (action.kind === "unsupported") {
      const recorded = appendOwnerIntent({
        receiptRoot: config.receiptRoot,
        owner,
        current,
        action,
        payload: base.payload,
        observedAt: now,
        unresolved: true,
      });
      return hookResult({
        observed: false,
        coverage: recorded.coverage,
        dispatchAllowed: false,
        code: recorded.code || "ODC_INTENT_UNSUPPORTED",
      });
    }
    if (action.kind === "control") {
      const authorized = authorizeOwnerControl({
        config,
        owner,
        action,
        current,
      });
      if (!authorized.ok) {
        return hookResult({
          observed: false,
          coverage: current,
          dispatchAllowed: false,
          code: authorized.code,
        });
      }
    }
    if (action.kind === "native-create") {
      if (owner.provider !== "claude") {
        const recorded = appendOwnerIntent({
          receiptRoot: config.receiptRoot,
          owner,
          current,
          action: { ...action, kind: "unsupported", action: "unsupported" },
          payload: base.payload,
          observedAt: now,
          unresolved: true,
        });
        return hookResult({
          observed: false,
          coverage: recorded.coverage,
          dispatchAllowed: false,
          code: "NATIVE_CONTRACT_PROVIDER_UNSUPPORTED",
        });
      }
      const saved = appendOwnerIntent({
        receiptRoot: config.receiptRoot,
        owner,
        current,
        action,
        payload: base.payload,
        observedAt: now,
      });
      return hookResult({
        observed: saved.ok,
        coverage: saved.coverage,
        dispatchAllowed: saved.ok,
        code: saved.code || null,
      });
    }
    const saved = appendOwnerIntent({
      receiptRoot: config.receiptRoot,
      owner,
      current,
      action,
      payload: base.payload,
      observedAt: now,
    });
    return hookResult({
      observed: saved.ok,
      coverage: saved.coverage,
      dispatchAllowed: saved.ok,
      code: saved.code || null,
    });
  }

  if (base.eventName !== "PostToolUse") {
    if (base.eventName === "PostToolUseFailure") {
      return failPendingOwnerIntent({ config, base, owner, current, now });
    }
    return hookResult({ observed: true, coverage: current });
  }
  if (action.kind === "readonly") {
    return observeKnownOwnerJobPost({
      config,
      base,
      owner,
      current,
      action,
      now,
    });
  }
  if (action.kind === "native-control") {
    return observeKnownNativeTaskPost({
      config,
      base,
      owner,
      current,
      action,
      now,
    });
  }
  if (action.kind === "native-create") {
    return observeNativeContractCreate({
      config,
      base,
      owner,
      current,
      action,
      now,
    });
  }
  return settleOwnerIntent({
    config,
    base,
    owner,
    current,
    action,
    now,
  });
}

function hookResult({
  observed = true,
  joined = false,
  coverage = null,
  dispatchAllowed = true,
  code = null,
  ...extra
} = {}) {
  const summary = coverage
    ? {
        complete: coverage.complete === true,
        epochId: coverage.record?.epoch?.id || null,
        pendingCount: coverage.record
          ? coverage.record.intents.filter((row) => row.status === "pending")
              .length
          : 0,
        knownJobCount: coverage.record?.jobs?.length || 0,
        lastObservedAt: coverage.record?.lastObservedAt || null,
        path: coverage.path || null,
        sha256: coverage.sha256 || null,
        mtime: coverage.mtime || null,
        code: coverage.code || null,
      }
    : {
        complete: false,
        epochId: null,
        pendingCount: 0,
        knownJobCount: 0,
        lastObservedAt: null,
        path: null,
        sha256: null,
        mtime: null,
        code: code || null,
      };
  return {
    observed,
    joined,
    coverage: summary,
    dispatchAllowed,
    code,
    ...extra,
  };
}

function observeOwnerSessionStart({ config, base, owner, now }) {
  const current = readOwnerCoverage(config.receiptRoot, owner);
  const reopened = reopenOrphanStopCoverage({ config, owner, current, now });
  if (reopened) {
    return hookResult({
      observed: reopened.ok,
      coverage: reopened.coverage,
      dispatchAllowed: reopened.coverage.complete,
      code: reopened.coverage.code || null,
    });
  }
  if (current.record || current.code !== "ODC_OWNER_COVERAGE_MISSING") {
    return hookResult({
      observed: current.complete,
      coverage: current,
      dispatchAllowed: current.complete,
      code: current.code || null,
    });
  }
  if (base.payload.source !== "startup") {
    return hookResult({
      observed: false,
      coverage: current,
      dispatchAllowed: false,
      code: "ODC_OWNER_COVERAGE_LEGACY",
    });
  }
  const epoch = {
    id: crypto.randomUUID(),
    eventName: "SessionStart",
    source: "startup",
    observedAt: now,
    payloadHash: hashText(
      JSON.stringify({
        provider: owner.provider,
        providerSessionKey: owner.providerSessionKey,
        nativeSessionId: owner.nativeSessionId,
        eventName: "SessionStart",
        source: "startup",
      }),
    ),
  };
  const record = {
    schemaVersion: "otm.odc-owner-coverage.v1",
    provider: owner.provider,
    providerSessionKey: owner.providerSessionKey,
    nativeSessionId: owner.nativeSessionId,
    createdAt: now,
    lastObservedAt: now,
    sequence: 0,
    complete: true,
    invalidatedCode: null,
    epoch,
    intents: [],
    jobs: [],
    nativeTasks: [],
    subagents: [],
  };
  const saved = writeOwnerCoverage({
    receiptRoot: config.receiptRoot,
    owner,
    current,
    record,
  });
  return hookResult({
    observed: saved.ok,
    coverage: saved.coverage,
    dispatchAllowed: saved.ok,
    code: saved.code || null,
  });
}

function observeNativeSubagent({ config, base, owner, current, now }) {
  const payload = base.payload;
  const agentId = payload.agent_id;
  if (!current.complete || !current.record || !validId(agentId)) {
    return hookResult({
      observed: false,
      coverage: current,
      dispatchAllowed: true,
      code: current.code || "NATIVE_SUBAGENT_ID_INVALID",
    });
  }
  const sourceHash = hashBoundedObject(
    {
      provider: owner.provider,
      nativeSessionId: owner.nativeSessionId,
      eventName: base.eventName,
      agentId,
      observedAt: now,
    },
    MAX_ODC_PROCESS_BYTES,
  );
  if (!sourceHash) {
    return hookResult({
      observed: false,
      coverage: current,
      code: "NATIVE_SUBAGENT_HASH_FAILED",
    });
  }
  const existing = current.record.subagents.find(
    (row) => row.agentId === agentId,
  );
  let subagents;
  if (
    base.eventName === "SubagentStart" &&
    owner.provider === "claude" &&
    existing &&
    existing.status === "stopped"
  ) {
    // Claude resumes a finished agent under its original id (SendMessage to a
    // completed worker), so a start after a recorded stop reactivates the row.
    subagents = current.record.subagents.map((row) =>
      row.agentId === agentId
        ? {
            ...row,
            status: "active",
            startedAt: now,
            startHash: sourceHash,
            stoppedAt: null,
            stopHash: null,
            resumes: (Number.isSafeInteger(row.resumes) ? row.resumes : 0) + 1,
          }
        : row,
    );
  } else if (base.eventName === "SubagentStart") {
    if (
      existing ||
      current.record.subagents.length >= MAX_OWNER_COVERAGE_ENTRIES
    ) {
      const coverage = invalidateOwnerCoverage({
        receiptRoot: config.receiptRoot,
        owner,
        current,
        code: existing
          ? "NATIVE_SUBAGENT_START_DUPLICATE"
          : "ODC_OWNER_COVERAGE_CAPACITY",
        observedAt: now,
      });
      return hookResult({ observed: false, coverage, code: coverage.code });
    }
    subagents = [
      ...current.record.subagents,
      {
        agentId,
        status: "active",
        startedAt: now,
        startHash: sourceHash,
        stoppedAt: null,
        stopHash: null,
      },
    ];
  } else {
    if (!existing || existing.status !== "active") {
      // A stop never represents running work. An untyped, transcript-less helper
      // stop has no identity to match, so it is ignored rather than invalidating.
      if (
        isAbsentText(payload.agent_type) &&
        isAbsentText(payload.agent_transcript_path)
      ) {
        return hookResult({
          observed: true,
          coverage: current,
          dispatchAllowed: true,
          code: null,
        });
      }
      // Claude emits typed SubagentStop without a SubagentStart for internal
      // agents (e.g. the auto-compaction summarizer). Running Claude agents are
      // reported by the Stop hook's background_tasks, so an orphan stop is
      // counted rather than invalidating the session for its remaining lifetime.
      if (owner.provider === "claude") {
        return recordOrphanClaudeStop({ config, owner, current, now });
      }
      const coverage = invalidateOwnerCoverage({
        receiptRoot: config.receiptRoot,
        owner,
        current,
        code: "NATIVE_SUBAGENT_STOP_UNMATCHED",
        observedAt: now,
      });
      return hookResult({ observed: false, coverage, code: coverage.code });
    }
    subagents = current.record.subagents.map((row) =>
      row.agentId === agentId
        ? { ...row, status: "stopped", stoppedAt: now, stopHash: sourceHash }
        : row,
    );
  }
  const next = {
    ...current.record,
    sequence: current.record.sequence + 1,
    lastObservedAt: now,
    subagents,
  };
  const saved = writeOwnerCoverage({
    receiptRoot: config.receiptRoot,
    owner,
    current,
    record: next,
  });
  return hookResult({
    observed: saved.ok,
    coverage: saved.coverage,
    code: saved.code || null,
  });
}

function recordOrphanClaudeStop({ config, owner, current, now }) {
  const prior = Number.isSafeInteger(current.record.orphanSubagentStops)
    ? current.record.orphanSubagentStops
    : 0;
  const saved = writeOwnerCoverage({
    receiptRoot: config.receiptRoot,
    owner,
    current,
    record: {
      ...current.record,
      sequence: current.record.sequence + 1,
      lastObservedAt: now,
      orphanSubagentStops: Math.min(prior + 1, MAX_OWNER_COVERAGE_ENTRIES),
    },
  });
  return hookResult({
    observed: saved.ok,
    coverage: saved.coverage,
    code: saved.code || null,
  });
}

/**
 * Claude sessions invalidated only by an orphan SubagentStop (before orphan
 * stops were tolerated) are reopened at the next SessionStart when the record
 * holds no active subagent or pending intent. ODC dispatch was denied while the
 * record was incomplete, so no owner work can have started unrecorded.
 */
function reopenOrphanStopCoverage({ config, owner, current, now }) {
  const record = current.record;
  if (
    owner.provider !== "claude" ||
    !record ||
    record.invalidatedCode !== "NATIVE_SUBAGENT_STOP_UNMATCHED" ||
    record.subagents.some((row) => row.status !== "stopped") ||
    record.intents.some((row) => row.status !== "settled")
  ) {
    return null;
  }
  return writeOwnerCoverage({
    receiptRoot: config.receiptRoot,
    owner,
    current,
    record: {
      ...record,
      sequence: record.sequence + 1,
      complete: true,
      invalidatedCode: null,
      lastObservedAt: now,
    },
  });
}

/** True when an optional hook field is missing, null, or blank. Non-string values count as present. */
function isAbsentText(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

function observeNativeContractCreate({
  config,
  base,
  owner,
  current,
  action,
  now,
}) {
  const intentIndex = findPendingIntent(current, base.payload, action);
  if (intentIndex < 0)
    return invalidateUnmatchedIntent(config, owner, current, now);
  const response = decodeToolResponse(base.payload.tool_response);
  const routeInput = hostRouteArguments(base.payload, action.route);
  const requestedRoot = absolutePath(routeInput?.root);
  const requestedTaskId = routeInput?.taskId;
  const contractResponse = response && extractNativeContractResponse(response);
  const runtimeRoots = trustedProjectRoots(config, base.run);
  const projectRoot =
    requestedRoot &&
    runtimeRoots.find((root) => isWithinRoot(requestedRoot, root));
  const expectedTaskId = contractResponse
    ? "claude_" +
      crypto
        .createHash("sha256")
        .update(contractResponse.transportSessionId)
        .digest("hex")
        .slice(0, 16) +
      "_" +
      requestedTaskId
    : null;
  if (
    owner.provider !== "claude" ||
    !projectRoot ||
    !validId(requestedTaskId) ||
    !contractResponse ||
    contractResponse.taskId !== expectedTaskId ||
    contractResponse.brokerOwnerSessionId !==
      "claude:" + contractResponse.transportSessionId
  ) {
    return unresolvedIntentResult({
      config,
      owner,
      current,
      intentIndex,
      now,
      code: "NATIVE_CONTRACT_RESPONSE_UNJOINED",
      responseHash: response
        ? hashBoundedObject(response, MAX_ODC_PROCESS_BYTES)
        : null,
    });
  }
  const taskDir = path.join(
    projectRoot,
    ".codex",
    "overtli-orchestration",
    contractResponse.taskId,
  );
  const statePath = path.join(taskDir, "state-v1.json");
  let stateRead;
  let state;
  try {
    assertSafeDirectory(projectRoot);
    assertSafeDirectory(taskDir);
    stateRead = readStableFile(statePath, MAX_NATIVE_STATE_BYTES);
    if (!stateRead) throw errorCode("NATIVE_CONTRACT_STATE_MISSING");
    state = parseJson(stateRead.bytes, "NATIVE_CONTRACT_STATE_INVALID");
  } catch (error) {
    return unresolvedIntentResult({
      config,
      owner,
      current,
      intentIndex,
      now,
      code: safeCode(error),
      responseHash: hashBoundedObject(response, MAX_ODC_PROCESS_BYTES),
    });
  }
  const snapshot = contractResponse.snapshot;
  const validState =
    state?.schemaVersion === 1 &&
    state.taskId === contractResponse.taskId &&
    state.contract?.ownerSessionId === contractResponse.brokerOwnerSessionId &&
    state.contract?.executionProvider === "claude" &&
    state.contract?.executionArchitecture === "native" &&
    snapshot?.taskId === state.taskId &&
    snapshot?.contract?.ownerSessionId === state.contract.ownerSessionId &&
    snapshot?.contract?.executionProvider === "claude" &&
    snapshot?.contract?.executionArchitecture === "native";
  if (!validState) {
    return unresolvedIntentResult({
      config,
      owner,
      current,
      intentIndex,
      now,
      code: "NATIVE_CONTRACT_STATE_MISMATCH",
      responseHash: hashBoundedObject(response, MAX_ODC_PROCESS_BYTES),
    });
  }
  const responseHash = hashBoundedObject(response, MAX_ODC_PROCESS_BYTES);
  const link = {
    taskId: state.taskId,
    brokerOwnerSessionId: state.contract.ownerSessionId,
    projectRoot,
    observedAt: now,
    stateSha256: stateRead.sha256,
    responseSha256: responseHash,
  };
  const existing = current.record.nativeTasks.find(
    (row) => row.taskId === state.taskId,
  );
  if (
    existing &&
    (existing.brokerOwnerSessionId !== link.brokerOwnerSessionId ||
      existing.projectRoot !== link.projectRoot)
  ) {
    return unresolvedIntentResult({
      config,
      owner,
      current,
      intentIndex,
      now,
      code: "NATIVE_CONTRACT_OWNER_CONFLICT",
      responseHash,
    });
  }
  const jobs = current.record.jobs;
  const intents = current.record.intents.map((row, index) =>
    index === intentIndex ? { ...row, status: "settled", settledAt: now } : row,
  );
  const nativeTasks = existing
    ? current.record.nativeTasks
    : [...current.record.nativeTasks, link];
  const saved = writeOwnerCoverage({
    receiptRoot: config.receiptRoot,
    owner,
    current,
    record: {
      ...current.record,
      sequence: current.record.sequence + 1,
      lastObservedAt: now,
      intents,
      nativeTasks,
      jobs,
    },
  });
  return hookResult({
    observed: saved.ok,
    joined: saved.ok,
    coverage: saved.coverage,
    code: saved.code || null,
    taskId: saved.ok ? state.taskId : undefined,
  });
}

function extractNativeContractResponse(response) {
  if (
    response?.provider !== "claude" ||
    !validId(response.taskId) ||
    !response.snapshot ||
    typeof response.snapshot !== "object" ||
    Array.isArray(response.snapshot)
  )
    return null;
  const brokerOwnerSessionId = response.snapshot.contract?.ownerSessionId;
  if (
    typeof brokerOwnerSessionId !== "string" ||
    !brokerOwnerSessionId.startsWith("claude:")
  )
    return null;
  const transportSessionId = brokerOwnerSessionId.slice("claude:".length);
  if (!validId(transportSessionId)) return null;
  return {
    taskId: response.taskId,
    snapshot: response.snapshot,
    brokerOwnerSessionId,
    transportSessionId,
  };
}

function observeKnownNativeTaskPost({
  config,
  base,
  owner,
  current,
  action,
  now,
}) {
  const intentIndex = findPendingIntent(current, base.payload, action);
  if (intentIndex < 0)
    return invalidateUnmatchedIntent(config, owner, current, now);
  const args = hostRouteArguments(base.payload, action.route);
  const linked = current.record.nativeTasks.find(
    (row) => row.taskId === args?.taskId,
  );
  const root = absolutePath(args?.root);
  if (!linked || linked.projectRoot !== root) {
    return unresolvedIntentResult({
      config,
      owner,
      current,
      intentIndex,
      now,
      code: "NATIVE_CONTROL_TASK_UNJOINED",
    });
  }
  const response = decodeToolResponse(base.payload.tool_response);
  const taskDir = path.join(
    linked.projectRoot,
    ".codex",
    "overtli-orchestration",
    linked.taskId,
  );
  try {
    assertSafeDirectory(taskDir);
    const read = readStableFile(
      path.join(taskDir, "state-v1.json"),
      MAX_NATIVE_STATE_BYTES,
    );
    const state = read
      ? parseJson(read.bytes, "NATIVE_CONTROL_STATE_INVALID")
      : null;
    if (
      !state ||
      state.taskId !== linked.taskId ||
      state.contract?.ownerSessionId !== linked.brokerOwnerSessionId ||
      state.contract?.executionProvider !== "claude" ||
      state.contract?.executionArchitecture !== "native" ||
      !response
    )
      throw errorCode("NATIVE_CONTROL_STATE_UNVERIFIED");
    const responseHash = hashBoundedObject(response, MAX_ODC_PROCESS_BYTES);
    const intents = current.record.intents.map((row, index) =>
      index === intentIndex
        ? { ...row, status: "settled", settledAt: now }
        : row,
    );
    const nativeTasks = current.record.nativeTasks.map((row) =>
      row.taskId === linked.taskId ? { ...row, stateSha256: read.sha256 } : row,
    );
    const saved = writeOwnerCoverage({
      receiptRoot: config.receiptRoot,
      owner,
      current,
      record: {
        ...current.record,
        sequence: current.record.sequence + 1,
        lastObservedAt: now,
        intents,
        nativeTasks,
      },
    });
    return hookResult({
      observed: saved.ok,
      coverage: saved.coverage,
      code:
        saved.code ||
        (responseHash ? null : "NATIVE_CONTROL_RESPONSE_UNHASHABLE"),
    });
  } catch (error) {
    return unresolvedIntentResult({
      config,
      owner,
      current,
      intentIndex,
      now,
      code: safeCode(error),
    });
  }
}

function findPendingIntent(current, payload, action) {
  return current.record.intents.findIndex(
    (intent) =>
      intent.status === "pending" &&
      intent.toolUseId === payload.tool_use_id &&
      intent.turnId === (validId(payload.turn_id) ? payload.turn_id : null) &&
      intent.toolName === payload.tool_name &&
      intent.action === action.action,
  );
}

function invalidateUnmatchedIntent(config, owner, current, now) {
  const coverage = invalidateOwnerCoverage({
    receiptRoot: config.receiptRoot,
    owner,
    current,
    code: "ODC_POST_INTENT_UNMATCHED",
    observedAt: now,
  });
  return hookResult({
    observed: false,
    coverage,
    dispatchAllowed: true,
    code: "ODC_POST_INTENT_UNMATCHED",
  });
}

function unresolvedIntentResult({
  config,
  owner,
  current,
  intentIndex,
  now,
  code,
  responseHash = null,
}) {
  const record = {
    ...current.record,
    sequence: current.record.sequence + 1,
    complete: false,
    invalidatedCode: sanitizeCode(code),
    lastObservedAt: now,
    intents: current.record.intents.map((row, index) =>
      index === intentIndex
        ? { ...row, status: "unresolved", settledAt: now }
        : row,
    ),
  };
  const saved = writeOwnerCoverage({
    receiptRoot: config.receiptRoot,
    owner,
    current,
    record,
  });
  return hookResult({
    observed: false,
    coverage: saved.coverage,
    dispatchAllowed: true,
    code: saved.code || record.invalidatedCode,
    responseHash: validHash(responseHash) ? responseHash : undefined,
  });
}

function hostRouteArguments(payload, route) {
  let args = payload?.tool_input;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  if (parseOdcToolRoute(payload.tool_name)?.route === "system_write") {
    if (args.operationId !== route) return null;
    if (args.args && typeof args.args === "object" && !Array.isArray(args.args))
      args = args.args;
    else if (
      args.input &&
      typeof args.input === "object" &&
      !Array.isArray(args.input)
    )
      args = args.input;
  }
  return args;
}

function authorizeNativeTaskControl({ config, base, owner, action, current }) {
  if (owner.provider !== "claude")
    return { ok: false, code: "NATIVE_CONTROL_PROVIDER_UNSUPPORTED" };
  const args = hostRouteArguments(base.payload, action.route);
  const taskId = args?.taskId;
  const root = absolutePath(args?.root);
  const linked = current.record?.nativeTasks.find(
    (row) => row.taskId === taskId,
  );
  if (!linked || !root || linked.projectRoot !== root) {
    return { ok: false, code: "NATIVE_CONTROL_TASK_UNJOINED" };
  }
  try {
    const roots = trustedProjectRoots(config, base.run);
    if (!roots.some((trusted) => isWithinRoot(root, trusted))) {
      return { ok: false, code: "NATIVE_CONTROL_ROOT_UNTRUSTED" };
    }
    assertSafeDirectory(root);
    const taskDir = path.join(root, ".codex", "overtli-orchestration", taskId);
    assertSafeDirectory(taskDir);
    const read = readStableFile(
      path.join(taskDir, "state-v1.json"),
      MAX_NATIVE_STATE_BYTES,
    );
    const state = read
      ? parseJson(read.bytes, "NATIVE_CONTROL_STATE_INVALID")
      : null;
    if (
      !state ||
      state.taskId !== taskId ||
      state.contract?.ownerSessionId !== linked.brokerOwnerSessionId ||
      state.contract?.executionProvider !== "claude" ||
      state.contract?.executionArchitecture !== "native"
    )
      return { ok: false, code: "NATIVE_CONTROL_STATE_UNVERIFIED" };
    return { ok: true };
  } catch (error) {
    return { ok: false, code: safeCode(error) };
  }
}

function failPendingOwnerIntent({ config, base, owner, current, now }) {
  const payload = base.payload;
  const index =
    current.record?.intents.findIndex(
      (intent) =>
        intent.status === "pending" &&
        intent.toolUseId === payload.tool_use_id &&
        intent.turnId === (validId(payload.turn_id) ? payload.turn_id : null) &&
        intent.toolName === payload.tool_name,
    ) ?? -1;
  if (index < 0) return invalidateUnmatchedIntent(config, owner, current, now);
  return unresolvedIntentResult({
    config,
    owner,
    current,
    intentIndex: index,
    now,
    code: "ODC_TOOL_EXECUTION_OUTCOME_UNKNOWN",
  });
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep)
  );
}

function readOwnerCoverage(receiptRoot, owner) {
  const root = path.join(receiptRoot, "owners");
  const file = path.join(
    root,
    hashText(`${owner.provider}\0${owner.nativeSessionId}`) + ".json",
  );
  try {
    if (existsWithoutFollowingLink(file + ".lock")) {
      return {
        complete: false,
        record: null,
        path: file,
        sha256: null,
        mtime: null,
        code: "ODC_OWNER_COVERAGE_LOCK_PRESENT",
      };
    }
    const read = readStableFile(file, MAX_OWNER_COVERAGE_BYTES);
    if (!read) {
      return {
        complete: false,
        record: null,
        path: file,
        sha256: null,
        mtime: null,
        code: "ODC_OWNER_COVERAGE_MISSING",
      };
    }
    if (existsWithoutFollowingLink(file + ".lock")) {
      return {
        complete: false,
        record: null,
        path: file,
        sha256: read.sha256,
        mtime: read.mtime,
        code: "ODC_OWNER_COVERAGE_LOCK_PRESENT",
      };
    }
    const record = parseJson(read.bytes, "ODC_OWNER_COVERAGE_INVALID");
    if (!validOwnerCoverage(record, owner)) {
      return {
        complete: false,
        record: null,
        path: file,
        sha256: read.sha256,
        mtime: read.mtime,
        code: "ODC_OWNER_COVERAGE_INVALID",
      };
    }
    return {
      complete: record.complete === true && !record.invalidatedCode,
      record,
      path: file,
      sha256: read.sha256,
      mtime: read.mtime,
      code: record.invalidatedCode || null,
    };
  } catch (error) {
    return {
      complete: false,
      record: null,
      path: file,
      sha256: null,
      mtime: null,
      code: safeCode(error),
    };
  }
}

function validOwnerCoverage(record, owner) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.schemaVersion !== "otm.odc-owner-coverage.v1" ||
    record.provider !== owner.provider ||
    record.providerSessionKey !== owner.providerSessionKey ||
    record.nativeSessionId !== owner.nativeSessionId ||
    !validTimestamp(record.createdAt) ||
    !validTimestamp(record.lastObservedAt) ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 0 ||
    typeof record.complete !== "boolean" ||
    !record.epoch ||
    record.epoch.eventName !== "SessionStart" ||
    record.epoch.source !== "startup" ||
    !validId(record.epoch.id) ||
    !validTimestamp(record.epoch.observedAt) ||
    !validHash(record.epoch.payloadHash) ||
    !Array.isArray(record.intents) ||
    record.intents.length > MAX_OWNER_COVERAGE_ENTRIES ||
    !Array.isArray(record.jobs) ||
    record.jobs.length > MAX_OWNER_COVERAGE_ENTRIES ||
    !Array.isArray(record.nativeTasks) ||
    record.nativeTasks.length > MAX_OWNER_COVERAGE_ENTRIES ||
    !Array.isArray(record.subagents) ||
    record.subagents.length > MAX_OWNER_COVERAGE_ENTRIES
  ) {
    return false;
  }
  const intentIds = new Set();
  for (const intent of record.intents) {
    if (
      !intent ||
      typeof intent !== "object" ||
      !validId(intent.id) ||
      intentIds.has(intent.id) ||
      !validId(intent.toolUseId) ||
      (intent.turnId !== null && !validId(intent.turnId)) ||
      !isObservedToolName(intent.toolName) ||
      ![
        "start",
        "run",
        "input",
        "cancel",
        "native-create",
        "reserve",
        "operation",
        "transition",
        "complete",
        "review",
        "finalize",
        "steer",
        "checkpoint",
        "reissue",
        "unsupported",
      ].includes(intent.action) ||
      ![
        "odc-job",
        "odc-sync",
        "odc-control",
        "native-contract",
        "unsupported",
      ].includes(intent.kind) ||
      !["pending", "settled", "unresolved"].includes(intent.status) ||
      !validTimestamp(intent.observedAt) ||
      (intent.status !== "pending" && !validTimestamp(intent.settledAt)) ||
      (intent.jobId !== null && !JOB_ID_PATTERN.test(intent.jobId || "")) ||
      (intent.targetJobIdHash !== null && !validHash(intent.targetJobIdHash))
    ) {
      return false;
    }
    intentIds.add(intent.id);
  }
  const jobIds = new Set();
  for (const job of record.jobs) {
    if (
      !job ||
      typeof job !== "object" ||
      !JOB_ID_PATTERN.test(job.jobId || "") ||
      jobIds.has(job.jobId) ||
      !validId(job.odcOwnerSessionId) ||
      !validTimestamp(job.startedAt) ||
      !validStatus(job.status) ||
      job.creatorNativeSessionId !== owner.nativeSessionId ||
      !validTimestamp(job.lastObservedAt) ||
      (job.storeSha256 !== null && !validHash(job.storeSha256)) ||
      (job.terminalProof !== null &&
        !validTerminalJobProof(job.terminalProof, job, owner))
    ) {
      return false;
    }
    jobIds.add(job.jobId);
  }
  const nativeTaskIds = new Set();
  for (const task of record.nativeTasks) {
    if (
      !task ||
      typeof task !== "object" ||
      !validId(task.taskId) ||
      nativeTaskIds.has(task.taskId) ||
      !validId(task.brokerOwnerSessionId) ||
      !path.isAbsolute(task.projectRoot || "") ||
      !validTimestamp(task.observedAt) ||
      !validHash(task.stateSha256) ||
      !validHash(task.responseSha256)
    ) {
      return false;
    }
    nativeTaskIds.add(task.taskId);
  }
  const subagentIds = new Set();
  for (const subagent of record.subagents) {
    if (
      !subagent ||
      typeof subagent !== "object" ||
      !validId(subagent.agentId) ||
      subagentIds.has(subagent.agentId) ||
      !["active", "stopped", "unknown"].includes(subagent.status) ||
      !validTimestamp(subagent.startedAt) ||
      !validHash(subagent.startHash) ||
      (subagent.status === "stopped" &&
        (!validTimestamp(subagent.stoppedAt) || !validHash(subagent.stopHash)))
    ) {
      return false;
    }
    subagentIds.add(subagent.agentId);
  }
  return true;
}

function validTerminalJobProof(proof, job, owner) {
  return (
    !!proof &&
    typeof proof === "object" &&
    proof.jobId === job.jobId &&
    proof.odcOwnerSessionId === job.odcOwnerSessionId &&
    proof.startedAt === job.startedAt &&
    proof.nativeSessionId === owner.nativeSessionId &&
    TERMINAL_STATUSES.has(normalizedStatus(proof.status)) &&
    validTimestamp(proof.observedAt) &&
    validHash(proof.storeSha256) &&
    validHash(proof.responseSha256)
  );
}

function writeOwnerCoverage({ receiptRoot, owner, current, record }) {
  let ownersRoot;
  let lockRoot;
  let lockOwned = false;
  let temporary = null;
  try {
    ownersRoot = path.join(receiptRoot, "owners");
    ensureSafeDirectory(ownersRoot);
    const scan = readDirectory(ownersRoot, MAX_OWNER_COVERAGE_RECORDS);
    const file = path.join(
      ownersRoot,
      hashText(`${owner.provider}\0${owner.nativeSessionId}`) + ".json",
    );
    if (
      scan.truncated ||
      (!current.sha256 && scan.entries.length >= MAX_OWNER_COVERAGE_RECORDS)
    ) {
      throw errorCode("ODC_OWNER_COVERAGE_CAPACITY");
    }
    lockRoot = file + ".lock";
    fs.mkdirSync(lockRoot, { mode: 0o700 });
    lockOwned = true;
    const lockInfo = fs.lstatSync(lockRoot);
    if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) {
      throw errorCode("ODC_OWNER_COVERAGE_LOCK_UNSAFE");
    }
    const latest = readStableFile(file, MAX_OWNER_COVERAGE_BYTES);
    if (current.sha256) {
      if (!latest || latest.sha256 !== current.sha256) {
        throw errorCode("ODC_OWNER_COVERAGE_CHANGED");
      }
    } else if (latest) {
      throw errorCode("ODC_OWNER_COVERAGE_CHANGED");
    }
    const bytes = Buffer.from(JSON.stringify(record) + "\n", "utf8");
    if (bytes.length > MAX_OWNER_COVERAGE_BYTES) {
      throw errorCode("ODC_OWNER_COVERAGE_SIZE_LIMIT");
    }
    temporary = file + "." + crypto.randomUUID() + ".tmp";
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
    temporary = null;
    const verified = readStableFile(file, MAX_OWNER_COVERAGE_BYTES);
    if (!verified || verified.sha256 !== sha256(bytes)) {
      throw errorCode("ODC_OWNER_COVERAGE_WRITE_UNVERIFIED");
    }
    return {
      ok: true,
      coverage: {
        complete: record.complete === true && !record.invalidatedCode,
        record,
        path: file,
        sha256: verified.sha256,
        mtime: verified.mtime,
        code: record.invalidatedCode || null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      coverage: {
        complete: false,
        record: null,
        path: current.path || null,
        sha256: current.sha256 || null,
        mtime: current.mtime || null,
        code: safeCode(error),
      },
      code: safeCode(error),
    };
  } finally {
    if (temporary) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
    if (lockOwned && lockRoot) {
      try {
        fs.rmdirSync(lockRoot);
      } catch {}
    }
  }
}

function invalidateOwnerCoverage({
  receiptRoot,
  owner,
  current,
  code,
  observedAt,
}) {
  const record = {
    ...current.record,
    sequence: current.record.sequence + 1,
    complete: false,
    invalidatedCode: sanitizeCode(code),
    lastObservedAt: observedAt,
  };
  const saved = writeOwnerCoverage({ receiptRoot, owner, current, record });
  return saved.coverage;
}

function appendOwnerIntent({
  receiptRoot,
  owner,
  current,
  action,
  payload,
  observedAt,
}) {
  const toolUseId = payload.tool_use_id;
  const turnId = validId(payload.turn_id) ? payload.turn_id : null;
  if (!validId(toolUseId) || (owner.provider === "codex" && !turnId)) {
    return { ok: false, code: "ODC_HOOK_EVENT_ID_INVALID", coverage: current };
  }
  if (current.record.intents.length >= MAX_OWNER_COVERAGE_ENTRIES) {
    return {
      ok: false,
      code: "ODC_OWNER_COVERAGE_CAPACITY",
      coverage: current,
    };
  }
  if (
    current.record.intents.some(
      (intent) => intent.toolUseId === toolUseId && intent.status === "pending",
    )
  ) {
    const coverage = invalidateOwnerCoverage({
      receiptRoot,
      owner,
      current,
      code: "ODC_HOOK_INTENT_DUPLICATE",
      observedAt,
    });
    return { ok: false, code: "ODC_HOOK_INTENT_DUPLICATE", coverage };
  }
  const intent = {
    id: crypto.randomUUID(),
    action: action.action,
    kind:
      action.kind === "control"
        ? "odc-control"
        : ["native-create", "native-control"].includes(action.kind)
          ? "native-contract"
          : action.kind,
    toolName: payload.tool_name,
    toolUseId,
    turnId,
    observedAt,
    status: "pending",
    settledAt: null,
    jobId: null,
    targetJobIdHash: action.targetJobId ? hashText(action.targetJobId) : null,
  };
  const record = {
    ...current.record,
    sequence: current.record.sequence + 1,
    lastObservedAt: observedAt,
    intents: [...current.record.intents, intent],
  };
  const saved = writeOwnerCoverage({ receiptRoot, owner, current, record });
  return { ok: saved.ok, code: saved.code, coverage: saved.coverage };
}

function classifyHostTool(base) {
  const payload = base.payload;
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return isOdcToolName(payload.tool_name)
      ? { kind: "unsupported", action: "unsupported" }
      : null;
  }
  const parsed = parseOdcToolRoute(payload.tool_name);
  if (!parsed) return null;
  let route = parsed.route;
  let args = input;
  if (route === "system_write") {
    const operationId = input.operationId;
    if (typeof operationId !== "string" || !ODC_TOOLS.has(operationId)) {
      return { kind: "unsupported", action: "unsupported", route };
    }
    route = operationId;
    if (
      input.args &&
      typeof input.args === "object" &&
      !Array.isArray(input.args)
    ) {
      args = input.args;
    } else if (
      input.input &&
      typeof input.input === "object" &&
      !Array.isArray(input.input)
    ) {
      args = input.input;
    }
  }
  if (!ODC_TOOLS.has(route)) return null;
  const action = typeof args.action === "string" ? args.action : null;
  if (route === "process_job") {
    if (action === "start") return { kind: "odc-job", action: "start", route };
    if (["status", "output", "list"].includes(action))
      return { kind: "readonly", action, route };
    if (["input", "cancel"].includes(action))
      return controlAction(action, args.jobId, route);
    return { kind: "unsupported", action: action || "unsupported", route };
  }
  if (route === "script_job") {
    if (action === "start") return { kind: "odc-job", action: "start", route };
    if (["status", "output"].includes(action))
      return { kind: "readonly", action, route };
    if (action === "cancel") return controlAction(action, args.jobId, route);
    return { kind: "unsupported", action: action || "unsupported", route };
  }
  if (["process_run", "script_run"].includes(route)) {
    return { kind: "odc-sync", action: "run", route };
  }
  if (route === "execution_provider") {
    if (["dispatch", "resume"].includes(action))
      return { kind: "odc-job", action: "start", route };
    if (action === "status") return { kind: "readonly", action, route };
    if (action === "cancel") return controlAction(action, args.jobId, route);
    return { kind: "unsupported", action: action || "unsupported", route };
  }
  if (route === "agent_delegate") {
    if (action === "dispatch")
      return { kind: "odc-job", action: "start", route };
    if (["status", "review"].includes(action))
      return { kind: "readonly", action, route };
    return { kind: "unsupported", action: action || "unsupported", route };
  }
  if (route === "orchestration") {
    if (["status", "wait", "event", "completion"].includes(action))
      return { kind: "readonly", action, route };
    return { kind: "unsupported", action: action || "unsupported", route };
  }
  if (route === "youtube_media") {
    if (action === "start") return { kind: "odc-job", action: "start", route };
    if (["status", "capabilities", "cleanup", "export"].includes(action)) {
      return { kind: "readonly", action, route };
    }
    return { kind: "unsupported", action: action || "unsupported", route };
  }
  if (route === "audio_analysis") {
    if (action === "start") return { kind: "odc-job", action: "start", route };
    if (["status", "capabilities", "cleanup"].includes(action)) {
      return { kind: "readonly", action, route };
    }
    return { kind: "unsupported", action: action || "unsupported", route };
  }
  if (route === "media_proxy_pool") {
    if (["import", "check"].includes(action)) {
      return { kind: "odc-job", action: "start", route };
    }
    if (action === "status") return { kind: "readonly", action, route };
    return { kind: "unsupported", action: action || "unsupported", route };
  }
  if (route === "provider_contract") {
    if (action === "create")
      return { kind: "native-create", action: "native-create", route };
    if (["status", "wait"].includes(action))
      return { kind: "readonly", action, route };
    return { kind: "native-control", action: action || "unsupported", route };
  }
  if (route === "batch_execute") {
    if (["status", "list"].includes(action))
      return { kind: "readonly", action, route };
    return { kind: "unsupported", action: action || "unsupported", route };
  }
  return null;
}

function controlAction(action, targetJobId, route) {
  return {
    kind: "control",
    action,
    route,
    targetJobId:
      typeof targetJobId === "string" && JOB_ID_PATTERN.test(targetJobId)
        ? targetJobId
        : null,
  };
}

function parseOdcToolRoute(toolName) {
  if (typeof toolName !== "string") return null;
  for (const prefix of ODC_TOOL_PREFIXES) {
    if (toolName.startsWith(prefix))
      return { route: toolName.slice(prefix.length) };
  }
  return null;
}

function authorizeOwnerControl({ config, owner, action, current }) {
  if (!action.targetJobId)
    return { ok: false, code: "ODC_CONTROL_TARGET_INVALID" };
  const join = readJobJoin(config.receiptRoot, action.targetJobId);
  const ownerJob = current.record.jobs.find(
    (job) => job.jobId === action.targetJobId,
  );
  if (
    !join.ok ||
    !ownerJob ||
    !joinMatches(join.row, {
      id: ownerJob.jobId,
      ownerSessionId: ownerJob.odcOwnerSessionId,
      startedAt: ownerJob.startedAt,
    })
  ) {
    return { ok: false, code: "ODC_CONTROL_TARGET_UNJOINED" };
  }
  if (join.row.nativeSessionId !== owner.nativeSessionId) {
    return { ok: false, code: "ODC_CROSS_NATIVE_CONTROL_UNSUPPORTED" };
  }
  return { ok: true };
}

function settleOwnerIntent({ config, base, owner, current, action, now }) {
  const payload = base.payload;
  const intentIndex = findPendingIntent(current, payload, action);
  if (intentIndex < 0) {
    const coverage = invalidateOwnerCoverage({
      receiptRoot: config.receiptRoot,
      owner,
      current,
      code: "ODC_POST_INTENT_UNMATCHED",
      observedAt: now,
    });
    return hookResult({
      observed: false,
      coverage,
      dispatchAllowed: true,
      code: "ODC_POST_INTENT_UNMATCHED",
    });
  }

  const response = decodeToolResponse(payload.tool_response);
  const candidate = extractJobResponse(response);
  const runtime = readOdcStores(config.odcRuntimeRoot);
  const record = runtime.ok
    ? runtime.jobs.find((job) => job.id === candidate?.id)
    : null;
  const intent = current.record.intents[intentIndex];
  const responseHash = response
    ? hashBoundedObject(response, MAX_ODC_PROCESS_BYTES)
    : null;
  const validResponse =
    !!candidate &&
    !!runtime.ok &&
    !!record &&
    matchesReturnedRecord(candidate, record) &&
    (action.kind !== "odc-sync" ||
      (TERMINAL_STATUSES.has(normalizedStatus(record.status)) &&
        !runtime.owned.processes.some((marker) => marker?.id === record.id))) &&
    (action.kind !== "control" ||
      (intent.targetJobIdHash === hashText(candidate.id) &&
        current.record.jobs.some(
          (job) =>
            job.jobId === candidate.id &&
            job.creatorNativeSessionId === owner.nativeSessionId,
        )));
  if (!validResponse) {
    const unresolvedRecord = {
      ...current.record,
      sequence: current.record.sequence + 1,
      complete: false,
      invalidatedCode: sanitizeCode(
        runtime.ok ? "ODC_JOB_JOIN_UNKNOWN" : runtime.code,
      ),
      lastObservedAt: now,
      intents: current.record.intents.map((row, index) =>
        index === intentIndex
          ? { ...row, status: "unresolved", settledAt: now }
          : row,
      ),
    };
    const saved = writeOwnerCoverage({
      receiptRoot: config.receiptRoot,
      owner,
      current,
      record: unresolvedRecord,
    });
    return hookResult({
      observed: false,
      coverage: saved.coverage,
      dispatchAllowed: true,
      code: saved.code || unresolvedRecord.invalidatedCode,
    });
  }

  let join = null;
  if (action.kind === "odc-job" || action.kind === "odc-sync") {
    const receipt = {
      schemaVersion: "otm.odc-job-join.v1",
      provider: owner.provider,
      providerSessionKey: owner.providerSessionKey,
      nativeSessionId: owner.nativeSessionId,
      routeOwnerSessionId: base.run?.sessionId || null,
      runId: base.run?.id || null,
      routeRevision: base.run?.routeRevision ?? null,
      jobId: record.id,
      odcOwnerSessionId: record.ownerSessionId,
      statusAtHook: record.status,
      startedAt: record.startedAt,
      observedAt: now,
      toolOrigin: payload.tool_name,
      operationDiscriminator: action.route || null,
      payloadHash: hashBoundedObject(
        {
          hook_event_name: payload.hook_event_name,
          tool_name: payload.tool_name,
          tool_use_id: payload.tool_use_id,
          turn_id: payload.turn_id,
          action: "start",
        },
        MAX_ODC_PROCESS_BYTES,
      ),
      responseHash,
      processJobsSha256: runtime.jobsFile.sha256,
    };
    join = persistJoinReceipt(config.receiptRoot, receipt);
    if (!join.ok) {
      const coverage = invalidateOwnerCoverage({
        receiptRoot: config.receiptRoot,
        owner,
        current,
        code: join.code,
        observedAt: now,
      });
      return hookResult({
        observed: false,
        coverage,
        dispatchAllowed: true,
        code: join.code,
      });
    }
  } else {
    const existingJoin = readJobJoin(config.receiptRoot, record.id);
    if (
      !existingJoin.ok ||
      !existingJoin.row ||
      existingJoin.row.nativeSessionId !== owner.nativeSessionId
    ) {
      const code = existingJoin.code || "ODC_CROSS_NATIVE_CONTROL_UNSUPPORTED";
      const coverage = invalidateOwnerCoverage({
        receiptRoot: config.receiptRoot,
        owner,
        current,
        code,
        observedAt: now,
      });
      return hookResult({
        observed: false,
        coverage,
        dispatchAllowed: true,
        code,
      });
    }
  }

  const existingJob = current.record.jobs.find(
    (job) => job.jobId === record.id,
  );
  if (
    existingJob &&
    (existingJob.odcOwnerSessionId !== record.ownerSessionId ||
      existingJob.startedAt !== record.startedAt)
  ) {
    const coverage = invalidateOwnerCoverage({
      receiptRoot: config.receiptRoot,
      owner,
      current,
      code: "ODC_OWNER_JOB_IDENTITY_MISMATCH",
      observedAt: now,
    });
    return hookResult({
      observed: false,
      coverage,
      dispatchAllowed: true,
      code: "ODC_OWNER_JOB_IDENTITY_MISMATCH",
    });
  }
  const processMarkerPresent = runtime.owned.processes.some(
    (marker) => marker?.id === record.id,
  );
  const terminalProof =
    TERMINAL_STATUSES.has(normalizedStatus(record.status)) &&
    !processMarkerPresent &&
    responseHash
      ? makeTerminalJobProof({
          owner,
          record,
          observedAt: now,
          storeSha256: runtime.jobsFile.sha256,
          responseHash,
        })
      : existingJob?.terminalProof || null;
  const ownerJob = {
    jobId: record.id,
    odcOwnerSessionId: record.ownerSessionId,
    startedAt: record.startedAt,
    status: record.status,
    creatorNativeSessionId:
      existingJob?.creatorNativeSessionId || owner.nativeSessionId,
    lastObservedAt: now,
    storeSha256: runtime.jobsFile.sha256,
    terminalProof,
  };
  const intentChanged = {
    ...intent,
    status: "settled",
    settledAt: now,
    jobId: record.id,
  };
  const intents = current.record.intents.map((row, index) =>
    index === intentIndex ? intentChanged : row,
  );
  const jobs = existingJob
    ? current.record.jobs.map((job) =>
        job.jobId === record.id ? ownerJob : job,
      )
    : [...current.record.jobs, ownerJob];
  if (jobs.length > MAX_OWNER_COVERAGE_ENTRIES) {
    const coverage = invalidateOwnerCoverage({
      receiptRoot: config.receiptRoot,
      owner,
      current,
      code: "ODC_OWNER_COVERAGE_CAPACITY",
      observedAt: now,
    });
    return hookResult({
      observed: false,
      coverage,
      dispatchAllowed: true,
      code: "ODC_OWNER_COVERAGE_CAPACITY",
    });
  }
  const next = {
    ...current.record,
    sequence: current.record.sequence + 1,
    lastObservedAt: now,
    intents,
    jobs,
  };
  const saved = writeOwnerCoverage({
    receiptRoot: config.receiptRoot,
    owner,
    current,
    record: next,
  });
  return hookResult({
    observed: saved.ok,
    joined: saved.ok && ["odc-job", "odc-sync"].includes(action.kind),
    coverage: saved.coverage,
    dispatchAllowed: true,
    code: saved.code || null,
    ...(saved.ok
      ? {
          jobId: record.id,
          nativeSessionId: owner.nativeSessionId,
          receiptPath: join?.path || current.path,
          receiptSha256: join?.sha256 || current.sha256,
        }
      : {}),
  });
}

function observeKnownOwnerJobPost({
  config,
  base,
  owner,
  current,
  action,
  now,
}) {
  if (!["status", "output"].includes(action.action)) {
    return hookResult({ observed: true, coverage: current });
  }
  const response = decodeToolResponse(base.payload.tool_response);
  const candidate = extractJobResponse(response);
  if (!candidate) return hookResult({ observed: true, coverage: current });
  const ownerJob = current.record.jobs.find(
    (job) => job.jobId === candidate.id,
  );
  if (!ownerJob || ownerJob.creatorNativeSessionId !== owner.nativeSessionId) {
    return hookResult({
      observed: true,
      coverage: current,
      code: "ODC_JOB_NOT_CREATED_BY_OWNER",
    });
  }
  const runtime = readOdcStores(config.odcRuntimeRoot);
  if (!runtime.ok) {
    return hookResult({
      observed: false,
      coverage: current,
      code: runtime.code,
    });
  }
  const record = runtime.jobs.find((job) => job.id === candidate.id);
  if (!record || !matchesReturnedRecord(candidate, record)) {
    return hookResult({
      observed: false,
      coverage: current,
      code: "ODC_JOB_TERMINAL_PROOF_UNVERIFIED",
    });
  }
  const responseHash = hashBoundedObject(response, MAX_ODC_PROCESS_BYTES);
  const processMarkerPresent = runtime.owned.processes.some(
    (marker) => marker?.id === record.id,
  );
  const updatedJob = {
    ...ownerJob,
    status: record.status,
    lastObservedAt: now,
    storeSha256: runtime.jobsFile.sha256,
    terminalProof:
      TERMINAL_STATUSES.has(normalizedStatus(record.status)) &&
      !processMarkerPresent
        ? makeTerminalJobProof({
            owner,
            record,
            observedAt: now,
            storeSha256: runtime.jobsFile.sha256,
            responseHash,
          })
        : ownerJob.terminalProof,
  };
  const next = {
    ...current.record,
    sequence: current.record.sequence + 1,
    lastObservedAt: now,
    jobs: current.record.jobs.map((job) =>
      job.jobId === record.id ? updatedJob : job,
    ),
  };
  const saved = writeOwnerCoverage({
    receiptRoot: config.receiptRoot,
    owner,
    current,
    record: next,
  });
  return hookResult({
    observed: saved.ok,
    coverage: saved.coverage,
    code: saved.code || null,
    ...(saved.ok ? { jobId: record.id } : {}),
  });
}

function makeTerminalJobProof({
  owner,
  record,
  observedAt,
  storeSha256,
  responseHash,
}) {
  return {
    jobId: record.id,
    odcOwnerSessionId: record.ownerSessionId,
    startedAt: record.startedAt,
    nativeSessionId: owner.nativeSessionId,
    status: record.status,
    observedAt,
    storeSha256,
    responseSha256: responseHash,
  };
}

function validateInspectionInput(input) {
  const run = input?.run;
  const owner = run?.metadata?.providerSession;
  let derived = null;
  if (owner && ["codex", "claude"].includes(owner.provider)) {
    try {
      derived = createProviderSession({
        provider: owner.provider,
        nativeSessionId: owner.nativeSessionId,
      });
    } catch {
      derived = null;
    }
  }
  if (
    input?.schemaVersion !== HOST_CONTINUATION_EVIDENCE_SCHEMA ||
    !run ||
    typeof run !== "object" ||
    typeof run.id !== "string" ||
    !run.id ||
    !Number.isSafeInteger(run.routeRevision) ||
    !owner ||
    !["codex", "claude"].includes(owner.provider) ||
    !validId(owner.providerSessionKey) ||
    !validId(owner.nativeSessionId) ||
    !validId(run.id) ||
    run.routeRevision < 0 ||
    input.runId !== run.id ||
    input.routeRevision !== run.routeRevision ||
    input.ownerSession?.provider !== owner.provider ||
    input.ownerSession?.providerSessionKey !== owner.providerSessionKey ||
    input.ownerSession?.nativeSessionId !== owner.nativeSessionId ||
    !derived ||
    derived.providerSessionKey !== owner.providerSessionKey ||
    derived.sessionId !== run.sessionId ||
    typeof input.activityAt !== "string" ||
    !Number.isFinite(Date.parse(input.activityAt)) ||
    Date.parse(input.activityAt) > Date.now() ||
    !validId(input.activityEventId) ||
    !Array.isArray(input.events) ||
    !Array.isArray(input.requiredSources) ||
    input.requiredSources.length !== 2 ||
    new Set(input.requiredSources).size !== 2 ||
    input.requiredSources.some(
      (source) => !["native-broker", "odc-jobs"].includes(source),
    )
  ) {
    return { ok: false, code: "INSPECTION_CONTEXT_INVALID" };
  }
  const ownerActivities = input.events.filter(
    (candidate) =>
      candidate?.eventType === "provider_session_activity" &&
      candidate?.payload?.ownerSessionId === run.sessionId &&
      candidate?.payload?.providerSessionKey === owner.providerSessionKey,
  );
  const event = ownerActivities.at(-1);
  if (
    event?.id !== input.activityEventId ||
    event?.createdAt !== input.activityAt
  ) {
    return { ok: false, code: "ACTIVITY_EVENT_NOT_LATEST" };
  }
  const verifiedEvent = input.events.find(
    (candidate) =>
      candidate?.id === input.activityEventId &&
      candidate?.eventType === "provider_session_activity" &&
      candidate?.createdAt === input.activityAt &&
      candidate?.payload?.ownerSessionId === run.sessionId &&
      candidate?.payload?.providerSessionKey === owner.providerSessionKey,
  );
  if (!verifiedEvent) return { ok: false, code: "ACTIVITY_EVENT_UNVERIFIED" };
  if (
    input.workspaceRoot !== undefined &&
    input.workspaceRoot !== run.workspaceRoot
  ) {
    return { ok: false, code: "WORKSPACE_ROOT_MISMATCH" };
  }
  return {
    ok: true,
    run,
    owner: {
      provider: owner.provider,
      providerSessionKey: owner.providerSessionKey,
      nativeSessionId: owner.nativeSessionId,
    },
    activityAt: input.activityAt,
    activityEventId: input.activityEventId,
  };
}

function validateHookInput(input) {
  const payload = input?.payload;
  const run = input?.run;
  const supportedEvents = new Set([
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "PreCompact",
    "PostCompact",
    "SessionEnd",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
  ]);
  let derived;
  try {
    derived = createProviderSession({
      provider: input?.provider,
      nativeSessionId: input?.nativeSessionId,
    });
  } catch {
    return {
      ok: false,
      code: "HOST_HOOK_IDENTITY_UNVERIFIED",
      mismatch: "nativeSessionId",
    };
  }
  const owner = run?.metadata?.providerSession;
  const toolEvent = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
  ].includes(input?.eventName);
  const subagentEvent = ["SubagentStart", "SubagentStop"].includes(
    input?.eventName,
  );
  const optionalIdentityAliases = [
    "thread_id",
    "threadId",
    "conversation_id",
    "conversationId",
  ];
  const objectPayload =
    payload && typeof payload === "object" && !Array.isArray(payload);
  // Ordered named checks: the first failure names the exact mismatch so the
  // Stop message can say what differs instead of a bare identity code.
  const checks = [
    ["schemaVersion", input?.schemaVersion !== HOST_HOOK_OBSERVATION_SCHEMA],
    ["provider", !["codex", "claude"].includes(input?.provider)],
    ["eventName", !supportedEvents.has(input?.eventName)],
    ["payload", !objectPayload],
    ["hook_event_name", payload?.hook_event_name !== input?.eventName],
    ["session_id", payload?.session_id !== input?.nativeSessionId],
    [
      "turn_id",
      input?.provider === "codex" && toolEvent && !validId(payload?.turn_id),
    ],
    [
      "sessionAlias",
      objectPayload &&
        optionalIdentityAliases.some(
          (field) =>
            Object.hasOwn(payload, field) &&
            payload[field] !== input.nativeSessionId,
        ),
    ],
    [
      "tool",
      toolEvent &&
        (!validId(payload?.tool_use_id) ||
          typeof payload?.tool_name !== "string" ||
          !payload?.tool_input),
    ],
    ["agent_id", subagentEvent && !validId(payload?.agent_id)],
    ["nativeSessionId", !validId(input?.nativeSessionId)],
    [
      "providerSession",
      input?.providerSessionKey !== derived.providerSessionKey ||
        input?.sessionId !== derived.sessionId,
    ],
    [
      "routeOwner",
      Boolean(run) &&
        (!owner ||
          input.provider !== owner.provider ||
          input.nativeSessionId !== owner.nativeSessionId ||
          input.providerSessionKey !== owner.providerSessionKey ||
          input.sessionId !== run.sessionId),
    ],
    [
      "routeRevision",
      run
        ? input.routeRevision !== run.routeRevision ||
          typeof run.id !== "string" ||
          !Number.isSafeInteger(run.routeRevision)
        : input?.routeRevision !== null && input?.routeRevision !== undefined,
    ],
    [
      "workspaceRoot",
      input?.workspaceRoot !== undefined &&
        (!path.isAbsolute(input.workspaceRoot) ||
          (Boolean(run) && input.workspaceRoot !== run.workspaceRoot)),
    ],
  ];
  const failed = checks.find(([, failure]) => failure);
  if (failed) {
    return {
      ok: false,
      code: "HOST_HOOK_IDENTITY_UNVERIFIED",
      mismatch: failed[0],
    };
  }
  return {
    ok: true,
    provider: input.provider,
    eventName: input.eventName,
    payload,
    nativeSessionId: input.nativeSessionId,
    providerSessionKey: input.providerSessionKey,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot || null,
    run,
  };
}

function loadConfig() {
  const configuredPath = process.env.OTM_HOST_EVIDENCE_CONFIG;
  const configPath =
    configuredPath ||
    path.join(
      os.homedir(),
      ".claude",
      "overtli-task-manager",
      "host-evidence.json",
    );
  if (!path.isAbsolute(configPath)) throw errorCode("CONFIG_PATH_NOT_ABSOLUTE");
  const read = readStableFile(configPath, MAX_CONFIG_BYTES);
  if (!read) throw errorCode("CONFIG_MISSING");
  const parsed = parseJson(read.bytes, "CONFIG_INVALID");
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== 1 ||
    Object.keys(parsed).some(
      (key) =>
        ![
          "schemaVersion",
          "projectRoots",
          "odcRuntimeRoot",
          "receiptRoot",
        ].includes(key),
    ) ||
    !Array.isArray(parsed.projectRoots) ||
    parsed.projectRoots.length > MAX_NATIVE_ROOTS
  ) {
    throw errorCode("CONFIG_INVALID");
  }
  const localData = process.env.LOCALAPPDATA;
  const rootDefaults = localData
    ? path.join(localData, "Overtli", "DesktopCommander", "runtime")
    : null;
  const receiptDefaults = localData
    ? path.join(localData, "Overtli", "TaskManager", "host-evidence-v1")
    : null;
  const odcRuntimeRoot = absolutePath(parsed.odcRuntimeRoot || rootDefaults);
  const receiptRoot = absolutePath(parsed.receiptRoot || receiptDefaults);
  if (!odcRuntimeRoot || !receiptRoot) {
    throw errorCode("CONFIG_SOURCE_PATH_MISSING");
  }
  const projectRoots = parsed.projectRoots.map(absolutePath);
  if (projectRoots.some((root) => !root))
    throw errorCode("CONFIG_PROJECT_ROOT_INVALID");
  return {
    projectRoots: [...new Set(projectRoots)],
    odcRuntimeRoot,
    receiptRoot,
  };
}

function absolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value)
    ? path.resolve(value)
    : null;
}

function trustedProjectRoots(config, run) {
  const roots = [...config.projectRoots];
  if (typeof run?.workspaceRoot === "string" && run.workspaceRoot.trim()) {
    if (!path.isAbsolute(run.workspaceRoot)) {
      throw errorCode("WORKSPACE_ROOT_UNTRUSTED");
    }
    roots.push(path.resolve(run.workspaceRoot));
  }
  const unique = [...new Set(roots)];
  if (unique.length > MAX_NATIVE_ROOTS)
    throw errorCode("PROJECT_ROOT_LIMIT_EXCEEDED");
  return unique;
}

function assertReceiptRootDisjoint(config, projectRoots) {
  const receiptRoot = path.resolve(config.receiptRoot);
  const sourceRoots = [...projectRoots, path.resolve(config.odcRuntimeRoot)];
  if (sourceRoots.some((sourceRoot) => pathsOverlap(receiptRoot, sourceRoot))) {
    throw errorCode("RECEIPT_ROOT_OVERLAPS_SOURCE");
  }
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative) return true;
  const normalized = relative.toLowerCase();
  return (
    normalized !== ".." &&
    !normalized.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function inspectNativeBroker({ roots, owner, ownerCoverage, observedAt, now }) {
  const result = sourceResult("native-broker");
  if (!roots.length) return unknown(result, "NATIVE_ROOTS_UNCONFIGURED");
  if (owner.provider === "claude" && !ownerCoverage?.complete) {
    result.unknownWorkCount += 1;
    result.inventoryComplete = false;
    result.code = ownerCoverage?.code || "NATIVE_CLAUDE_OWNER_COVERAGE_UNKNOWN";
  }
  for (const subagent of ownerCoverage.record?.subagents || []) {
    if (subagent.status === "active") result.activeWorkCount += 1;
    else if (subagent.status === "unknown") {
      result.unknownWorkCount += 1;
      result.inventoryComplete = false;
      result.code = "NATIVE_SUBAGENT_OUTCOME_UNKNOWN";
    }
  }
  const rootReceipts = [];
  const nativeTasks = [];
  let sourceHashCount = 0;
  let taskEntriesScanned = 0;

  for (const projectRoot of roots) {
    try {
      assertSafeDirectory(projectRoot);
      const brokerRoot = path.join(
        projectRoot,
        ".codex",
        "overtli-orchestration",
      );
      const scan = readDirectory(brokerRoot, MAX_NATIVE_TASKS_PER_ROOT);
      if (scan.missing) {
        rootReceipts.push({
          root: projectRoot,
          brokerRoot,
          present: false,
          entries: 0,
          truncated: false,
          predicate: "known_project_root_readable_no_native_broker_folder",
        });
        continue;
      }
      if (scan.truncated) {
        result.truncated = true;
        result.unknownWorkCount += 1;
        result.inventoryComplete = false;
        result.code = "NATIVE_TASK_INVENTORY_CAPPED";
      }
      rootReceipts.push({
        root: projectRoot,
        brokerRoot,
        present: true,
        entries: scan.entries.length,
        scanned: scan.entries.length,
        truncated: scan.truncated,
        directoryMtime: scan.mtime,
        directorySha256: scan.namesHash,
        predicate: "immediate_task_directories_only",
      });
      for (const entry of scan.entries) {
        if (taskEntriesScanned >= MAX_NATIVE_TASKS_TOTAL) {
          result.truncated = true;
          result.unknownWorkCount += 1;
          result.inventoryComplete = false;
          result.code = "NATIVE_TASK_GLOBAL_INVENTORY_CAPPED";
          break;
        }
        taskEntriesScanned += 1;
        if (entry.isSymbolicLink()) {
          result.unknownWorkCount += 1;
          result.inventoryComplete = false;
          result.code = "NATIVE_TASK_PATH_UNSAFE";
          continue;
        }
        if (!entry.isDirectory()) continue;
        if (!ID_PATTERN.test(entry.name)) {
          result.unknownWorkCount += 1;
          result.inventoryComplete = false;
          result.code = "NATIVE_TASK_ID_INVALID";
          continue;
        }
        const taskDir = path.join(brokerRoot, entry.name);
        const statePath = path.join(taskDir, "state-v1.json");
        const stateRead = readStableFile(statePath, MAX_NATIVE_STATE_BYTES);
        if (!stateRead) {
          const taskLink = ownerCoverage.record?.nativeTasks.find(
            (row) =>
              row.taskId === entry.name && row.projectRoot === projectRoot,
          );
          const folder = readDirectory(taskDir, 128);
          const canonicalMarkers = folder.entries
            .filter((child) =>
              [
                "state-v1.json",
                "native-routing.json",
                "writer.lock",
                "native-routing.lock",
                "events.jsonl",
                "events.ndjson",
                "contract.json",
              ].includes(child.name),
            )
            .map((child) => child.name);
          const unsafeChildren = folder.entries.some((child) =>
            child.isSymbolicLink(),
          );
          if (
            folder.truncated ||
            unsafeChildren ||
            taskLink ||
            canonicalMarkers.length > 0
          ) {
            result.unknownWorkCount += 1;
            result.inventoryComplete = false;
            result.code = folder.truncated
              ? "NATIVE_UNREGISTERED_FOLDER_SCAN_CAPPED"
              : unsafeChildren
                ? "NATIVE_UNREGISTERED_FOLDER_UNSAFE_CHILD"
                : "NATIVE_TASK_STATE_MISSING";
          } else {
            nativeTasks.push({
              taskId: entry.name,
              projectRoot,
              scopeExclusion: true,
              directoryPath: taskDir,
              directoryMtime: folder.mtime,
              directorySha256: folder.namesHash,
              entries: folder.entries.length,
              predicate:
                "no canonical broker registration marker and no owner-journal link",
            });
          }
          continue;
        }
        sourceHashCount += 1;
        let state;
        try {
          state = parseJson(stateRead.bytes, "NATIVE_STATE_INVALID");
        } catch {
          result.unknownWorkCount += 1;
          result.inventoryComplete = false;
          result.code = "NATIVE_STATE_INVALID";
          continue;
        }
        if (
          state?.schemaVersion !== 1 ||
          state?.taskId !== entry.name ||
          !validId(state?.contract?.ownerSessionId) ||
          !state.workers ||
          typeof state.workers !== "object" ||
          Array.isArray(state.workers)
        ) {
          result.unknownWorkCount += 1;
          result.inventoryComplete = false;
          result.code = "NATIVE_STATE_OWNER_INVALID";
          continue;
        }

        const workerTargets = [];
        const ownerTaskLink = ownerCoverage.record?.nativeTasks.find(
          (row) =>
            row.taskId === entry.name &&
            row.projectRoot === projectRoot &&
            row.brokerOwnerSessionId === state.contract.ownerSessionId,
        );
        let related =
          state.contract.ownerSessionId === owner.nativeSessionId ||
          (owner.provider === "claude" &&
            !!ownerTaskLink &&
            state.contract.executionProvider === "claude" &&
            state.contract.executionArchitecture === "native");
        const allWorkers = Object.entries(state.workers);
        if (allWorkers.length > MAX_NATIVE_WORKERS_PER_TASK) {
          result.unknownWorkCount += 1;
          result.inventoryComplete = false;
          result.code = "NATIVE_WORKER_INVENTORY_CAPPED";
        }
        for (const [workerId, worker] of allWorkers.slice(
          0,
          MAX_NATIVE_WORKERS_PER_TASK,
        )) {
          if (!validId(workerId) || !worker || typeof worker !== "object") {
            result.unknownWorkCount += 1;
            result.inventoryComplete = false;
            result.code = "NATIVE_WORKER_INVALID";
            continue;
          }
          const ops = operationHistory(worker);
          if (ops.length > MAX_NATIVE_OPS_PER_WORKER) {
            result.unknownWorkCount += 1;
            result.inventoryComplete = false;
            result.code = "NATIVE_OPERATION_HISTORY_CAPPED";
          }
          for (const op of ops) {
            if (op?.target === owner.nativeSessionId) related = true;
          }
          workerTargets.push({
            workerId,
            worker,
            ops: ops.slice(-MAX_NATIVE_OPS_PER_WORKER),
          });
        }

        const taskReceipt = {
          taskId: entry.name,
          statePath,
          stateSha256: stateRead.sha256,
          stateMtime: stateRead.mtime,
          rootOwnerSessionId: state.contract.ownerSessionId,
          relevantToNativeSession: related,
          workerCount: workerTargets.length,
          active: 0,
          unknown: 0,
          workerObservations: [],
        };
        if (related) {
          const resource = inspectNativeLeases(state);
          result.activeWorkCount += resource.active;
          taskReceipt.active += resource.active;
          taskReceipt.resourceLeaseCount = Object.keys(
            state.resourceRuntime?.leases || {},
          ).length;
          taskReceipt.activeResourceLeaseCount = resource.active;
          result.unknownWorkCount += resource.unknown;
          taskReceipt.unknown += resource.unknown;
          if (resource.unknown) {
            result.inventoryComplete = false;
            result.code = "NATIVE_RESOURCE_LEASE_UNKNOWN";
          }
          const routingPath = path.join(taskDir, "native-routing.json");
          let routing = null;
          let routingRead = null;
          const hasNativeOps =
            state.contract.executionProvider !== "claude" &&
            workerTargets.some((row) =>
              row.ops.some((op) =>
                ["native-host-spawn", "native-host-resume"].includes(op?.kind),
              ),
            );
          if (hasNativeOps) {
            routingRead = readStableFile(routingPath, MAX_ROUTING_BYTES);
            taskReceipt.routingPath = routingPath;
            taskReceipt.routingSha256 = routingRead?.sha256 || null;
            taskReceipt.routingMtime = routingRead?.mtime || null;
            if (!routingRead) {
              taskReceipt.routingStatus =
                "missing; provider hook pair may independently prove exact terminal child";
            } else {
              sourceHashCount += 1;
              try {
                routing = parseJson(
                  routingRead.bytes,
                  "NATIVE_ROUTING_INVALID",
                );
                if (
                  routing.schema !== 1 ||
                  routing.task_id !== state.taskId ||
                  routing.root_session_id !== state.contract.ownerSessionId ||
                  !routing.workers ||
                  typeof routing.workers !== "object" ||
                  Object.keys(routing.workers).length >
                    MAX_NATIVE_WORKERS_PER_TASK
                ) {
                  throw errorCode("NATIVE_ROUTING_OWNER_INVALID");
                }
              } catch {
                routing = null;
                result.unknownWorkCount += 1;
                result.inventoryComplete = false;
                result.code = "NATIVE_ROUTING_OWNER_INVALID";
                taskReceipt.unknown += 1;
              }
            }
          }
          const lockPaths = [
            path.join(taskDir, "writer.lock"),
            path.join(taskDir, "native-routing.lock"),
          ];
          taskReceipt.lockPaths = lockPaths;
          if (lockPaths.some(existsWithoutFollowingLink)) {
            result.unknownWorkCount += 1;
            result.inventoryComplete = false;
            result.code = "NATIVE_WRITER_LOCK_PRESENT";
            taskReceipt.unknown += 1;
          }
          for (const row of workerTargets) {
            const workerResult = inspectNativeWorker({
              projectRoot,
              taskId: state.taskId,
              rootOwnerSessionId: state.contract.ownerSessionId,
              workerId: row.workerId,
              worker: row.worker,
              operations: row.ops,
              routing,
              routingSha256: routingRead?.sha256 || null,
              ownerCoverage,
              provider: state.contract.executionProvider || owner.provider,
              observedAt,
              now,
            });
            result.activeWorkCount += workerResult.active;
            result.unknownWorkCount += workerResult.unknown;
            taskReceipt.active += workerResult.active;
            taskReceipt.unknown += workerResult.unknown;
            if (workerResult.unknown) {
              result.inventoryComplete = false;
              result.code = workerResult.code || "NATIVE_WORKER_UNKNOWN";
            }
            if (workerResult.ref) {
              taskReceipt.workerReceipts = taskReceipt.workerReceipts || [];
              taskReceipt.workerReceipts.push(workerResult.ref);
            }
            taskReceipt.workerObservations.push({
              workerId: row.workerId,
              state: normalizedStatus(row.worker.state || row.worker.status),
              attempt: row.worker.attempt ?? null,
              operationCount: row.ops.length,
              latestBinding: row.ops
                .filter((op) => op?.kind === "native-host-spawn")
                .at(-1)
                ? {
                    operationId: row.ops
                      .filter((op) => op?.kind === "native-host-spawn")
                      .at(-1).operationId,
                    target: row.ops
                      .filter((op) => op?.kind === "native-host-spawn")
                      .at(-1).target,
                    at: row.ops
                      .filter((op) => op?.kind === "native-host-spawn")
                      .at(-1).at,
                  }
                : null,
              latestResume: row.ops
                .filter((op) => op?.kind === "native-host-resume")
                .at(-1)
                ? {
                    operationId: row.ops
                      .filter((op) => op?.kind === "native-host-resume")
                      .at(-1).operationId,
                    status: row.ops
                      .filter((op) => op?.kind === "native-host-resume")
                      .at(-1).status,
                    at: row.ops
                      .filter((op) => op?.kind === "native-host-resume")
                      .at(-1).at,
                  }
                : null,
              active: workerResult.active,
              unknown: workerResult.unknown,
              blockerCode: workerResult.code || null,
            });
          }
          const waits = inspectExternalWaits({
            projectRoot,
            taskId: state.taskId,
            waits: state.externalWaits,
            observedAt,
            now,
          });
          result.activeWorkCount += waits.active;
          result.unknownWorkCount += waits.unknown;
          taskReceipt.active += waits.active;
          taskReceipt.unknown += waits.unknown;
          if (waits.unknown) {
            result.inventoryComplete = false;
            result.code = waits.code || "NATIVE_EXTERNAL_WAIT_UNKNOWN";
          }
          if (waits.refs.length) taskReceipt.externalWaitReceipts = waits.refs;
        }
        nativeTasks.push(taskReceipt);
      }
    } catch (error) {
      result.unknownWorkCount += 1;
      result.inventoryComplete = false;
      result.code = safeCode(error);
      rootReceipts.push({
        root: projectRoot,
        present: null,
        predicate: "root-unreadable-or-unsafe",
      });
    }
  }
  for (const rootReceipt of rootReceipts) {
    if (!rootReceipt.brokerRoot) continue;
    try {
      const current = readDirectory(
        rootReceipt.brokerRoot,
        MAX_NATIVE_TASKS_PER_ROOT,
      );
      if (
        current.missing !== !rootReceipt.present ||
        (!current.missing &&
          (current.namesHash !== rootReceipt.directorySha256 ||
            current.truncated !== rootReceipt.truncated))
      ) {
        result.unknownWorkCount += 1;
        result.inventoryComplete = false;
        result.code = "NATIVE_TASK_INVENTORY_CHANGED";
      }
    } catch {
      result.unknownWorkCount += 1;
      result.inventoryComplete = false;
      result.code = "NATIVE_TASK_INVENTORY_RECHECK_FAILED";
    }
  }
  for (const task of nativeTasks) {
    try {
      if (task.scopeExclusion) {
        const current = readDirectory(task.directoryPath, 128);
        const markers = current.entries.some((child) =>
          [
            "state-v1.json",
            "native-routing.json",
            "writer.lock",
            "native-routing.lock",
            "events.jsonl",
            "events.ndjson",
            "contract.json",
          ].includes(child.name),
        );
        const unsafeChildren = current.entries.some((child) =>
          child.isSymbolicLink(),
        );
        if (
          current.missing ||
          current.truncated ||
          markers ||
          unsafeChildren ||
          current.namesHash !== task.directorySha256
        ) {
          result.unknownWorkCount += 1;
          result.inventoryComplete = false;
          result.code = "NATIVE_SCOPE_EXCLUSION_CHANGED";
        }
        continue;
      }
      const currentState = readStableFile(
        task.statePath,
        MAX_NATIVE_STATE_BYTES,
      );
      if (!currentState || currentState.sha256 !== task.stateSha256) {
        result.unknownWorkCount += 1;
        result.inventoryComplete = false;
        result.code = "NATIVE_TASK_STATE_CHANGED";
      }
      if (task.routingPath) {
        const currentRouting = readStableFile(
          task.routingPath,
          MAX_ROUTING_BYTES,
        );
        if (!currentRouting || currentRouting.sha256 !== task.routingSha256) {
          result.unknownWorkCount += 1;
          result.inventoryComplete = false;
          result.code = "NATIVE_ROUTING_CHANGED";
        }
      }
      for (const proof of task.workerReceipts || []) {
        const currentProof = readStableFile(
          proof.path,
          proof.source === "codex-native-hook" ||
            proof.source === "claude-native-hook"
            ? MAX_OWNER_COVERAGE_BYTES
            : MAX_HOST_RECEIPT_BYTES,
        );
        if (!currentProof || currentProof.sha256 !== proof.sha256) {
          result.unknownWorkCount += 1;
          result.inventoryComplete = false;
          result.code = "NATIVE_TERMINAL_RECEIPT_CHANGED";
        }
      }
      if ((task.lockPaths || []).some(existsWithoutFollowingLink)) {
        result.unknownWorkCount += 1;
        result.inventoryComplete = false;
        result.code = "NATIVE_WRITER_LOCK_PRESENT";
      }
    } catch {
      result.unknownWorkCount += 1;
      result.inventoryComplete = false;
      result.code = "NATIVE_TASK_RECHECK_FAILED";
    }
  }
  result.observed = {
    roots: rootReceipts,
    taskCount: sourceHashCount,
    taskEvidence: nativeTasks,
    activePredicate:
      "relevant owner task worker state or resourceRuntime lease ACTIVE/UNCERTAIN; expired leases remain blocking",
    terminalPredicate:
      "exact current binding and retained provider-native terminal hook pair or codex-native-host receipt plus unchanged state hashes",
    scopeExclusionPredicate:
      "immediate task directory without canonical broker registration markers and without a verified current-owner task link is recorded as out of broker scope; directory names are rechecked",
    scanBounds: {
      roots: MAX_NATIVE_ROOTS,
      immediateTaskDirectoriesPerRoot: MAX_NATIVE_TASKS_PER_ROOT,
      totalTaskDirectories: MAX_NATIVE_TASKS_TOTAL,
      workersPerTask: MAX_NATIVE_WORKERS_PER_TASK,
      operationHistoryPerWorker: MAX_NATIVE_OPS_PER_WORKER,
    },
    observedAt,
  };
  return result;
}

function inspectNativeWorker({
  projectRoot,
  taskId,
  rootOwnerSessionId,
  workerId,
  worker,
  operations,
  routing,
  routingSha256,
  ownerCoverage,
  provider,
  observedAt,
  now,
}) {
  const result = { active: 0, unknown: 0, ref: null };
  if (
    worker.ownershipRetained === true ||
    worker.cancelRequested === true ||
    worker.steeringInvalidated === true
  ) {
    result.unknown += 1;
    result.code = "NATIVE_WORKER_FLAG_UNSETTLED";
    return result;
  }
  const status = normalizedStatus(worker.state || worker.status);
  if (ACTIVE_STATUSES.has(status)) {
    result.active += 1;
  } else if (!TERMINAL_STATUSES.has(status)) {
    result.unknown += 1;
    result.code = "NATIVE_WORKER_STATUS_UNKNOWN";
    return result;
  }

  const nativeOps = operations.filter((op) =>
    ["native-host-spawn", "native-host-resume"].includes(op?.kind),
  );
  if (!nativeOps.length) {
    if (!ACTIVE_STATUSES.has(status)) {
      result.unknown += 1;
      result.code = "NATIVE_TERMINAL_BINDING_MISSING";
    }
    return result;
  }
  const attempt = worker.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    result.unknown += 1;
    result.code = "NATIVE_WORKER_ATTEMPT_INVALID";
    return result;
  }
  const bindings = nativeOps.filter(
    (op) =>
      op.kind === "native-host-spawn" &&
      op.operationId === "native-bind:" + attempt,
  );
  const binding = bindings.at(-1);
  if (
    !binding ||
    !validId(binding.target) ||
    binding.confirmed !== true ||
    !validTimestamp(binding.at)
  ) {
    result.unknown += 1;
    result.code = "NATIVE_CURRENT_BINDING_UNVERIFIED";
    return result;
  }
  const routingWorker = routing?.workers?.[workerId] || null;
  if (routingWorker) {
    const packageFingerprint = hashBoundedObject(
      worker.package,
      MAX_ROUTING_BYTES,
    );
    if (
      !packageFingerprint ||
      routingWorker.package_fingerprint !== packageFingerprint
    ) {
      result.unknown += 1;
      result.code = "NATIVE_PACKAGE_FINGERPRINT_MISMATCH";
      return result;
    }
    if (routingWorker.result && routingWorker.result.attempt !== attempt) {
      result.unknown += 1;
      result.code = "NATIVE_ROUTING_ATTEMPT_MISMATCH";
      return result;
    }
  }

  const bindingIndex = operations.lastIndexOf(binding);
  const subsequentOps = operations.slice(bindingIndex + 1);
  let latestResume = null;
  for (const op of subsequentOps) {
    const opStatus = normalizedStatus(op?.status);
    if (op?.kind === "native-host-resume") {
      latestResume = op;
      if (
        !TERMINAL_STATUSES.has(opStatus) ||
        op.confirmed !== true ||
        normalizedStatus(op.recoveryStatus) === "in-progress"
      ) {
        result.active += ACTIVE_STATUSES.has(opStatus) ? 1 : 0;
        result.unknown += ACTIVE_STATUSES.has(opStatus) ? 0 : 1;
        result.code = "NATIVE_RESUME_NOT_TERMINAL";
        return result;
      }
      continue;
    }
    if (ACTIVE_STATUSES.has(opStatus)) {
      result.active += 1;
      return result;
    }
    if (!TERMINAL_STATUSES.has(opStatus)) {
      result.unknown += 1;
      result.code = "NATIVE_OPERATION_STATUS_UNKNOWN";
      return result;
    }
  }
  if (result.active) return result;

  if (!TERMINAL_STATUSES.has(status)) return result;
  let terminal = null;
  if (provider === "codex" && routingWorker) {
    terminal = findNativeTerminalReceipt({
      projectRoot,
      taskId,
      workerId,
      childSessionId: binding.target,
      attempt,
      minimumAt: latestResume?.at || binding.at,
      routingWorker,
      worker,
      observedAt,
      now,
    });
  }
  if (!terminal?.ok) {
    terminal = findOwnerSubagentTerminal({
      ownerCoverage,
      provider,
      childSessionId: binding.target,
      minimumAt: latestResume?.at || binding.at,
      observedAt,
    });
  }
  if (!terminal.ok) {
    result.unknown += 1;
    result.code =
      terminal.code || "NATIVE_TERMINAL_RECEIPT_MISSING_OR_MISMATCHED";
    return result;
  }
  result.ref = {
    source: terminal.source,
    taskId,
    workerId,
    childSessionId: binding.target,
    attempt,
    terminalState: terminal.state,
    observedAt,
    sourceObservedAt: terminal.sourceObservedAt,
    path: terminal.path,
    sha256: terminal.sha256,
    mtime: terminal.mtime || null,
    routingSha256,
    operationId: latestResume?.operationId || binding.operationId,
    rootOwnerSessionId,
  };
  return result;
}

function findOwnerSubagentTerminal({
  ownerCoverage,
  provider,
  childSessionId,
  minimumAt,
  observedAt,
}) {
  if (
    !ownerCoverage?.complete ||
    !ownerCoverage.record ||
    ownerCoverage.record.provider !== provider
  ) {
    return {
      ok: false,
      code: ownerCoverage?.code || "NATIVE_SUBAGENT_COVERAGE_UNKNOWN",
    };
  }
  const proof = ownerCoverage.record.subagents.find(
    (row) =>
      row.agentId === childSessionId &&
      row.status === "stopped" &&
      Date.parse(row.startedAt) >= Date.parse(minimumAt || "") &&
      Date.parse(row.stoppedAt) >= Date.parse(minimumAt || "") &&
      Date.parse(row.startedAt) <= Date.parse(row.stoppedAt),
  );
  if (!proof)
    return { ok: false, code: "NATIVE_SUBAGENT_TERMINAL_PAIR_MISSING" };
  return {
    ok: true,
    source: provider === "codex" ? "codex-native-hook" : "claude-native-hook",
    state: "completed",
    sourceObservedAt: proof.stoppedAt,
    observedAt,
    startObservedAt: proof.startedAt,
    startSha256: proof.startHash,
    stopSha256: proof.stopHash,
    path: ownerCoverage.path,
    sha256: ownerCoverage.sha256,
    mtime: ownerCoverage.mtime,
  };
}

function findNativeTerminalReceipt({
  projectRoot,
  taskId,
  workerId,
  childSessionId,
  attempt,
  minimumAt,
  routingWorker,
  worker,
  observedAt,
  now,
}) {
  const refs = [];
  const addRefs = (value) => {
    if (Array.isArray(value)) {
      for (const ref of value.slice(0, 32)) {
        if (typeof ref === "string" && ref.length <= 4000) refs.push(ref);
      }
    }
  };
  addRefs(routingWorker.result?.evidence_refs);
  addRefs(worker.packet?.evidence_refs);
  const latestResume = operationHistory(worker)
    .filter((op) => op?.kind === "native-host-resume")
    .at(-1);
  if (typeof latestResume?.evidenceFingerprint === "string") {
    refs.push(latestResume.evidenceFingerprint);
  }
  const expectedNamespace = path.join(
    ".codex",
    "overtli-orchestration",
    taskId,
    "workers",
    workerId,
  );
  const seen = new Set();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const file = path.resolve(projectRoot, ref);
    const relative = path.relative(projectRoot, file);
    if (
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      !relative.startsWith(expectedNamespace + path.sep)
    ) {
      continue;
    }
    try {
      const read = readStableFile(file, MAX_HOST_RECEIPT_BYTES);
      if (!read) continue;
      const proof = parseJson(read.bytes, "NATIVE_TERMINAL_RECEIPT_INVALID");
      const state = normalizedStatus(proof.state || proof.terminal_state);
      const sourceObservedAt = proof.observed_at;
      const observedMs = Date.parse(sourceObservedAt || "");
      const minMs = Date.parse(minimumAt || "");
      if (
        proof.source !== "codex-native-host" ||
        proof.task_id !== taskId ||
        proof.worker_id !== workerId ||
        proof.child_session_id !== childSessionId ||
        proof.attempt !== attempt ||
        !HOST_TERMINAL_STATES.has(state) ||
        !Number.isFinite(observedMs) ||
        observedMs > now ||
        !Number.isFinite(minMs) ||
        observedMs < minMs
      ) {
        continue;
      }
      return {
        ok: true,
        state,
        sourceObservedAt,
        observedAt,
        path: file,
        sha256: read.sha256,
        mtime: read.mtime,
      };
    } catch {
      // Candidate evidence may be unrelated to this host receipt.
    }
  }
  return { ok: false, code: "NATIVE_TERMINAL_RECEIPT_MISSING_OR_MISMATCHED" };
}

function inspectExternalWaits({ projectRoot, taskId, waits, observedAt, now }) {
  const result = { active: 0, unknown: 0, refs: [] };
  if (waits === undefined || waits === null) return result;
  if (!waits || typeof waits !== "object" || Array.isArray(waits)) {
    return { ...result, unknown: 1, code: "NATIVE_EXTERNAL_WAITS_INVALID" };
  }
  const entries = Object.entries(waits);
  if (entries.length > 256) {
    return { ...result, unknown: 1, code: "NATIVE_EXTERNAL_WAITS_CAPPED" };
  }
  for (const [operationId, wait] of entries) {
    if (!wait || typeof wait !== "object" || Array.isArray(wait)) {
      result.unknown += 1;
      continue;
    }
    const status = normalizedStatus(wait.status);
    if (ACTIVE_STATUSES.has(status) || wait.resume_eligible === true) {
      result.active += 1;
      continue;
    }
    if (!TERMINAL_STATUSES.has(status)) {
      result.unknown += 1;
      continue;
    }
    const ref = wait.terminal_evidence_ref;
    if (typeof ref !== "string" || !ref) {
      result.unknown += 1;
      continue;
    }
    const file = path.resolve(projectRoot, ref);
    const namespace = path.join(
      ".codex",
      "overtli-orchestration",
      taskId,
      "workers",
      validId(wait.worker_id) ? wait.worker_id : "",
    );
    const relative = path.relative(projectRoot, file);
    if (
      !wait.worker_id ||
      relative.startsWith("..") ||
      !relative.startsWith(namespace + path.sep)
    ) {
      result.unknown += 1;
      continue;
    }
    try {
      const read = readStableFile(file, MAX_HOST_RECEIPT_BYTES);
      if (!read) {
        result.unknown += 1;
        continue;
      }
      const record = parseJson(read.bytes, "NATIVE_WAIT_RECEIPT_INVALID");
      if (
        record.source !== "codex-native-host" ||
        record.task_id !== taskId ||
        record.worker_id !== wait.worker_id ||
        record.child_session_id !== wait.child_id ||
        record.attempt !== wait.attempt ||
        !HOST_TERMINAL_STATES.has(
          normalizedStatus(record.state || record.terminal_state),
        ) ||
        !validTimestamp(record.observed_at) ||
        Date.parse(record.observed_at) > now
      ) {
        result.unknown += 1;
        continue;
      }
      result.refs.push({
        operationId,
        workerId: wait.worker_id,
        childSessionId: wait.child_id,
        attempt: wait.attempt,
        sourceObservedAt: record.observed_at,
        observedAt,
        path: file,
        sha256: read.sha256,
        mtime: read.mtime,
      });
    } catch {
      result.unknown += 1;
    }
  }
  return result;
}

function inspectNativeLeases(state) {
  const hasResourceGraph =
    state.resourceGraph !== undefined && state.resourceGraph !== null;
  const runtime = state.resourceRuntime;
  if (!hasResourceGraph && runtime === undefined) {
    return { active: 0, unknown: 0, count: 0 };
  }
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    return { active: 0, unknown: 1 };
  }
  const leases = runtime.leases;
  if (leases === undefined || leases === null) {
    return { active: 0, unknown: 1, count: 0 };
  }
  if (typeof leases !== "object" || Array.isArray(leases)) {
    return { active: 0, unknown: 1, count: 0 };
  }
  let active = 0;
  let unknown = 0;
  const entries = Object.values(leases);
  if (entries.length > 256)
    return { active: 0, unknown: 1, count: entries.length };
  for (const lease of entries) {
    const status = normalizedStatus(lease?.status);
    if (["active", "uncertain"].includes(status)) active += 1;
    else if (
      ![
        "released",
        "expired",
        "completed",
        "cancelled",
        "canceled",
        "committed",
        "aborted",
      ].includes(status)
    )
      unknown += 1;
  }
  return { active, unknown, count: entries.length };
}

function operationHistory(worker) {
  if (Array.isArray(worker.operationHistory)) return worker.operationHistory;
  if (Array.isArray(worker.operations)) return worker.operations;
  return [];
}

function inspectOdc({
  runtimeRoot,
  receiptRoot,
  owner,
  ownerCoverage,
  observedAt,
}) {
  const result = sourceResult("odc-jobs");
  if (!ownerCoverage?.complete || !ownerCoverage.record) {
    result.unknownWorkCount += 1;
    result.inventoryComplete = false;
    result.code = ownerCoverage?.code || "ODC_OWNER_COVERAGE_UNKNOWN";
    result.observed = {
      runtimeRoot,
      ownerCoveragePath: ownerCoverage?.path || null,
      ownerCoverageSha256: ownerCoverage?.sha256 || null,
      negativeAbsencePredicate:
        "unavailable because complete owner-scoped startup coverage is missing",
      inspectedAt: observedAt,
    };
    return result;
  }
  try {
    assertSafeDirectory(runtimeRoot);
    const stores = readOdcStores(runtimeRoot);
    if (!stores.ok) return unknown(result, stores.code);
    const live = stores.owned.processes;
    const records = new Map(stores.jobs.map((job) => [job.id, job]));
    const idempotency = new Map(
      stores.idempotency.map((row) => [row.record.id, row.record]),
    );
    const markers = new Map();
    const joinCache = new Map();
    const ownerJobs = new Map(
      ownerCoverage.record.jobs.map((job) => [job.jobId, job]),
    );
    const unknownJobIds = new Set();
    const markUnknown = (id, code) => {
      if (!unknownJobIds.has(id)) result.unknownWorkCount += 1;
      unknownJobIds.add(id);
      result.inventoryComplete = false;
      result.code = code;
    };
    const joinFor = (jobId) => {
      if (!joinCache.has(jobId))
        joinCache.set(jobId, readJobJoin(receiptRoot, jobId));
      return joinCache.get(jobId);
    };
    for (const marker of live) {
      const markerId = marker && typeof marker === "object" ? marker.id : null;
      if (!validId(markerId) || !ownerJobs.has(markerId)) continue;
      if (
        !Number.isSafeInteger(marker.pid) ||
        marker.pid <= 0 ||
        typeof marker.runId !== "string" ||
        !marker.runId ||
        markers.has(markerId)
      ) {
        markUnknown(markerId, "ODC_LIVE_MARKER_INVALID");
        continue;
      }
      markers.set(markerId, marker);
    }

    const observedJobs = [];
    const countedActiveJobs = new Set();
    const markActive = (job, status, source) => {
      if (!countedActiveJobs.has(job.jobId)) {
        result.activeWorkCount += 1;
        countedActiveJobs.add(job.jobId);
      }
      observedJobs.push({
        id: job.jobId,
        status,
        source,
        owner: owner.nativeSessionId,
      });
    };

    for (const intent of ownerCoverage.record.intents) {
      if (intent.status !== "settled") {
        markUnknown(intent.id, "ODC_OWNER_INTENT_UNSETTLED");
        continue;
      }
      if (
        ["odc-job", "odc-sync"].includes(intent.kind) &&
        (!intent.jobId || !ownerJobs.has(intent.jobId))
      ) {
        markUnknown(intent.id, "ODC_OWNER_INTENT_JOB_PROOF_MISSING");
      }
    }

    for (const ownerJob of ownerCoverage.record.jobs) {
      const join = joinFor(ownerJob.jobId);
      if (
        !join.ok ||
        !join.row ||
        !joinMatches(join.row, {
          id: ownerJob.jobId,
          ownerSessionId: ownerJob.odcOwnerSessionId,
          startedAt: ownerJob.startedAt,
        }) ||
        join.row.nativeSessionId !== owner.nativeSessionId ||
        join.row.providerSessionKey !== owner.providerSessionKey
      ) {
        markUnknown(
          ownerJob.jobId,
          join.code || "ODC_OWNER_JOIN_MISSING_OR_MISMATCHED",
        );
        continue;
      }
      const durable = records.get(ownerJob.jobId);
      if (
        durable &&
        (durable.ownerSessionId !== ownerJob.odcOwnerSessionId ||
          durable.startedAt !== ownerJob.startedAt)
      ) {
        markUnknown(ownerJob.jobId, "ODC_OWNER_JOB_IDENTITY_MISMATCH");
        continue;
      }
      const idem = idempotency.get(ownerJob.jobId);
      if (
        idem &&
        (idem.ownerSessionId !== ownerJob.odcOwnerSessionId ||
          idem.startedAt !== ownerJob.startedAt)
      ) {
        markUnknown(ownerJob.jobId, "ODC_OWNER_IDEMPOTENCY_IDENTITY_MISMATCH");
        continue;
      }
      const marker = markers.get(ownerJob.jobId);
      if (marker) {
        markActive(ownerJob, "live-marker", "owned-processes");
        continue;
      }
      const currentStatus = normalizedStatus(
        durable?.status || idem?.status || ownerJob.status,
      );
      if (currentStatus === "interrupted") {
        markUnknown(ownerJob.jobId, "ODC_JOB_OUTCOME_UNKNOWN");
        continue;
      }
      if (ACTIVE_STATUSES.has(currentStatus)) {
        markActive(
          ownerJob,
          currentStatus,
          durable ? "process-jobs" : "owner-coverage",
        );
        continue;
      }
      if (!TERMINAL_STATUSES.has(currentStatus)) {
        markUnknown(ownerJob.jobId, "ODC_OWNER_JOB_STATUS_UNKNOWN");
        continue;
      }
      if (
        !ownerJob.terminalProof ||
        !validTerminalJobProof(ownerJob.terminalProof, ownerJob, owner) ||
        normalizedStatus(ownerJob.terminalProof.status) !== currentStatus
      ) {
        markUnknown(ownerJob.jobId, "ODC_JOB_TERMINAL_PROOF_MISSING_OR_STALE");
        continue;
      }
      observedJobs.push({
        id: ownerJob.jobId,
        status: currentStatus,
        joined: true,
        terminalProof: true,
      });
    }

    const jobsAgain = readStableFile(
      path.join(runtimeRoot, "process-jobs.json"),
      MAX_ODC_STORE_BYTES,
    );
    const ownedAgain = readStableFile(
      path.join(runtimeRoot, "owned-processes.json"),
      MAX_ODC_PROCESS_BYTES,
    );
    const idempotencyAgain = readStableFile(
      path.join(runtimeRoot, "idempotency.json"),
      MAX_ODC_STORE_BYTES,
    );
    const joinsStable = [...joinCache.entries()].every(([jobId, initial]) => {
      const current = readJobJoin(receiptRoot, jobId);
      return (
        initial.ok === current.ok &&
        initial.sha256 === current.sha256 &&
        initial.code === current.code
      );
    });
    if (
      !jobsAgain ||
      !ownedAgain ||
      !idempotencyAgain ||
      jobsAgain.sha256 !== stores.jobsFile.sha256 ||
      ownedAgain.sha256 !== stores.ownedFile.sha256 ||
      idempotencyAgain.sha256 !== stores.idempotencyFile.sha256 ||
      !joinsStable
    ) {
      result.unknownWorkCount += 1;
      result.inventoryComplete = false;
      result.code = "ODC_INVENTORY_CHANGED_DURING_INSPECTION";
    }

    result.truncated =
      stores.jobs.length >= MAX_ODC_JOBS ||
      stores.idempotency.length >= MAX_IDEMPOTENCY_ROWS;
    result.observed = {
      runtimeRoot,
      stores: [
        storeSummary(stores.jobsFile, stores.jobs.length, MAX_ODC_JOBS),
        storeSummary(stores.ownedFile, live.length, null),
        storeSummary(
          stores.idempotencyFile,
          stores.idempotency.length,
          MAX_IDEMPOTENCY_ROWS,
        ),
      ],
      joinReceiptRoot: path.join(receiptRoot, "joins"),
      ownerCoverage: {
        complete: ownerCoverage.complete,
        path: ownerCoverage.path,
        sha256: ownerCoverage.sha256,
        mtime: ownerCoverage.mtime,
        epochId: ownerCoverage.record.epoch.id,
        intentCount: ownerCoverage.record.intents.length,
        pendingIntentCount: ownerCoverage.record.intents.filter(
          (row) => row.status === "pending",
        ).length,
        knownJobCount: ownerCoverage.record.jobs.length,
      },
      ownerJoinCount: joinCache.size,
      ownedProcessMarkerCount: live.length,
      uncorrelatedGlobalJobCount: stores.jobs.filter(
        (job) => !ownerJobs.has(job.id),
      ).length,
      activePredicate:
        "owner-scoped journal jobs reconciled to direct immutable exact join receipts, latest durable status and live marker; foreign joins are excluded",
      negativeAbsencePredicate:
        "stable bounded ODC inventories plus complete current-owner startup coverage account for every supported ODC creation intent; foreign global rows do not poison this owner, while unknown owner intents block",
      truncated: result.truncated,
      jobs: observedJobs.slice(0, MAX_ODC_JOBS),
      inspectedAt: observedAt,
    };
    return result;
  } catch (error) {
    return unknown(result, safeCode(error));
  }
}

function readOdcStores(runtimeRoot) {
  const jobsFile = readStableFile(
    path.join(runtimeRoot, "process-jobs.json"),
    MAX_ODC_STORE_BYTES,
  );
  const ownedFile = readStableFile(
    path.join(runtimeRoot, "owned-processes.json"),
    MAX_ODC_PROCESS_BYTES,
  );
  const idempotencyFile = readStableFile(
    path.join(runtimeRoot, "idempotency.json"),
    MAX_ODC_STORE_BYTES,
  );
  if (!jobsFile || !ownedFile || !idempotencyFile) {
    return { ok: false, code: "ODC_INVENTORY_FILE_MISSING" };
  }
  const jobData = parseJson(jobsFile.bytes, "ODC_JOB_STORE_INVALID");
  const owned = parseJson(ownedFile.bytes, "ODC_OWNED_STORE_INVALID");
  const idempotency = parseJson(
    idempotencyFile.bytes,
    "ODC_IDEMPOTENCY_STORE_INVALID",
  );
  const jobs = Array.isArray(jobData) ? jobData : jobData?.jobs;
  if (
    (!Array.isArray(jobData) && jobData?.schema !== 1) ||
    !Array.isArray(jobs) ||
    jobs.length > MAX_ODC_JOBS ||
    owned?.schema !== 1 ||
    !Array.isArray(owned.processes) ||
    owned.processes.length > 1024 ||
    !Array.isArray(idempotency) ||
    idempotency.length > MAX_IDEMPOTENCY_ROWS
  ) {
    return { ok: false, code: "ODC_INVENTORY_SCHEMA_INVALID" };
  }
  const seenJobs = new Set();
  for (const job of jobs) {
    if (
      !job ||
      typeof job !== "object" ||
      !JOB_ID_PATTERN.test(job.id || "") ||
      !validId(job.ownerSessionId) ||
      !validTimestamp(job.startedAt) ||
      !validStatus(job.status) ||
      seenJobs.has(job.id)
    ) {
      return { ok: false, code: "ODC_JOB_RECORD_INVALID" };
    }
    seenJobs.add(job.id);
  }
  for (const row of idempotency) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.key !== "string" ||
      row.key.length < 1 ||
      row.key.length > 2048 ||
      !validTimestamp(row.expiresAt) ||
      !row.record ||
      typeof row.record !== "object" ||
      !JOB_ID_PATTERN.test(row.record.id || "") ||
      !validId(row.record.ownerSessionId) ||
      !validTimestamp(row.record.startedAt) ||
      !validStatus(row.record.status)
    ) {
      return { ok: false, code: "ODC_IDEMPOTENCY_RECORD_INVALID" };
    }
  }
  return {
    ok: true,
    jobs,
    owned,
    idempotency,
    jobsFile,
    ownedFile,
    idempotencyFile,
  };
}

function readJobJoin(receiptRoot, jobId) {
  if (!JOB_ID_PATTERN.test(jobId || "")) {
    return {
      ok: false,
      row: null,
      code: "ODC_JOIN_JOB_ID_INVALID",
      sha256: null,
    };
  }
  const file = path.join(receiptRoot, "joins", hashText(jobId) + ".json");
  try {
    const read = readStableFile(file, 16 * 1024);
    if (!read)
      return {
        ok: false,
        row: null,
        code: "ODC_OWNER_JOIN_MISSING",
        sha256: null,
      };
    const row = parseJson(read.bytes, "ODC_JOIN_RECEIPT_INVALID");
    if (
      row?.schemaVersion !== "otm.odc-job-join.v1" ||
      row.jobId !== jobId ||
      !validId(row.nativeSessionId) ||
      !validId(row.providerSessionKey) ||
      !validId(row.odcOwnerSessionId) ||
      !validTimestamp(row.startedAt) ||
      !validTimestamp(row.observedAt) ||
      (row.statusAtHook !== undefined && !validStatus(row.statusAtHook))
    ) {
      return {
        ok: false,
        row: null,
        code: "ODC_JOIN_RECEIPT_IDENTITY_INVALID",
        sha256: read.sha256,
      };
    }
    return {
      ok: true,
      row,
      path: file,
      sha256: read.sha256,
      mtime: read.mtime,
    };
  } catch (error) {
    return { ok: false, row: null, code: safeCode(error), sha256: null };
  }
}

function persistJoinReceipt(receiptRoot, receipt) {
  try {
    const joinsRoot = path.join(receiptRoot, "joins");
    ensureSafeDirectory(joinsRoot);
    const file = path.join(joinsRoot, hashText(receipt.jobId) + ".json");
    const previous = readStableFile(file, MAX_ODC_PROCESS_BYTES);
    if (previous) {
      const parsed = parseJson(previous.bytes, "ODC_JOIN_RECEIPT_INVALID");
      const same =
        parsed?.schemaVersion === "otm.odc-job-join.v1" &&
        parsed.jobId === receipt.jobId &&
        parsed.nativeSessionId === receipt.nativeSessionId &&
        parsed.provider === receipt.provider &&
        parsed.providerSessionKey === receipt.providerSessionKey &&
        parsed.odcOwnerSessionId === receipt.odcOwnerSessionId &&
        parsed.startedAt === receipt.startedAt;
      return same
        ? { ok: true, path: file, sha256: previous.sha256, existing: true }
        : { ok: false, code: "ODC_JOB_JOIN_CONFLICT" };
    }
    const count = readDirectory(joinsRoot, MAX_JOIN_RECEIPTS);
    if (
      count.truncated ||
      count.entries.filter((entry) => entry.isFile()).length >=
        MAX_JOIN_RECEIPTS
    ) {
      return { ok: false, code: "ODC_JOIN_RECEIPTS_CAPPED" };
    }
    const bytes = Buffer.from(JSON.stringify(receipt) + "\n", "utf8");
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    return { ok: true, path: file, sha256: sha256(bytes), existing: false };
  } catch (error) {
    return { ok: false, code: safeCode(error) };
  }
}

function decodeToolResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return null;
  if (
    response.structuredContent &&
    typeof response.structuredContent === "object" &&
    !Array.isArray(response.structuredContent)
  ) {
    return boundedObject(response.structuredContent, MAX_ODC_PROCESS_BYTES);
  }
  if (Array.isArray(response.content) && response.content.length > 0) {
    const first = response.content[0];
    if (first?.type !== "text" || typeof first.text !== "string") return null;
    if (Buffer.byteLength(first.text, "utf8") > MAX_ODC_PROCESS_BYTES)
      return null;
    try {
      const parsed = JSON.parse(first.text);
      return boundedObject(parsed, MAX_ODC_PROCESS_BYTES);
    } catch {
      return null;
    }
  }
  return boundedObject(response, MAX_ODC_PROCESS_BYTES);
}

function extractJobResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return null;
  const wrapped =
    response.job &&
    typeof response.job === "object" &&
    !Array.isArray(response.job)
      ? response.job
      : null;
  const processRecord =
    response.process &&
    typeof response.process === "object" &&
    !Array.isArray(response.process)
      ? response.process
      : null;
  const source = wrapped || response;
  const rawId =
    typeof source.id === "string"
      ? source.id
      : typeof source.jobId === "string"
        ? source.jobId
        : typeof processRecord?.jobId === "string"
          ? processRecord.jobId
          : null;
  const rawOwner =
    source.ownerSessionId ||
    processRecord?.ownerSessionId ||
    processRecord?.owner ||
    null;
  const status = source.status || processRecord?.status || null;
  const startedAt = source.startedAt || processRecord?.startedAt || null;
  if (!JOB_ID_PATTERN.test(rawId || "") || !validId(rawOwner)) return null;
  if (
    (status !== null && !validStatus(status)) ||
    (startedAt !== null && !validTimestamp(startedAt))
  )
    return null;
  return {
    id: rawId,
    ownerSessionId: rawOwner,
    ...(status !== null ? { status } : {}),
    ...(startedAt !== null ? { startedAt } : {}),
  };
}

function matchesReturnedRecord(candidate, record) {
  return (
    candidate.id === record.id &&
    candidate.ownerSessionId === record.ownerSessionId &&
    (candidate.status === undefined ||
      normalizedStatus(candidate.status) === normalizedStatus(record.status)) &&
    (candidate.startedAt === undefined ||
      candidate.startedAt === record.startedAt)
  );
}

function joinMatches(join, job) {
  return (
    !!join &&
    join.jobId === job.id &&
    join.odcOwnerSessionId === job.ownerSessionId &&
    join.startedAt === job.startedAt
  );
}

function isOdcToolName(value) {
  const route = parseOdcToolRoute(value)?.route;
  return route === "system_write" || ODC_TOOLS.has(route);
}

function isObservedToolName(value) {
  return isOdcToolName(value);
}

function persistSourceReceipts({
  sourceResults,
  receiptRoot,
  owner,
  run,
  activityAt,
  activityEventId,
  observedAt,
}) {
  const refs = [];
  try {
    const inspections = path.join(receiptRoot, "inspections");
    ensureSafeDirectory(inspections);
    const scan = readDirectory(inspections, MAX_INSPECTION_RECEIPTS);
    if (
      scan.truncated ||
      scan.entries.length + sourceResults.length > MAX_INSPECTION_RECEIPTS
    ) {
      return { ok: false, code: "HOST_INSPECTION_RECEIPTS_CAPPED" };
    }
    const inspectionId = crypto.randomUUID();
    for (const source of sourceResults) {
      const body = {
        schemaVersion: "otm.host-source-observation.v1",
        inspectionId,
        source: source.id,
        owner,
        runId: run.id,
        routeRevision: run.routeRevision,
        activityAt,
        activityEventId,
        observedAt,
        inventoryComplete: source.inventoryComplete,
        activeWorkCount: source.activeWorkCount,
        unknownWorkCount: source.unknownWorkCount,
        truncated: source.truncated === true,
        sourcePredicates: source.observed || {},
        blockerCode: source.code || null,
      };
      const bytes = Buffer.from(JSON.stringify(body) + "\n", "utf8");
      if (bytes.length > MAX_SOURCE_RECEIPT_BYTES) {
        return { ok: false, code: "HOST_SOURCE_RECEIPT_SIZE_LIMIT" };
      }
      const file = path.join(
        inspections,
        inspectionId + "-" + source.id + ".json",
      );
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      refs.push({
        recordId: inspectionId + ":" + source.id,
        ownerSessionId: owner.nativeSessionId,
        observedAt,
        path: file,
        sha256: sha256(bytes),
      });
    }
    return { ok: true, refs };
  } catch (error) {
    return { ok: false, code: safeCode(error) };
  }
}

function failedInspection(input, observedAt, code) {
  const run = input?.run;
  const owner = run?.metadata?.providerSession;
  return {
    schemaVersion: HOST_CONTINUATION_EVIDENCE_SCHEMA,
    complete: false,
    runId: typeof run?.id === "string" ? run.id : null,
    routeRevision: Number.isSafeInteger(run?.routeRevision)
      ? run.routeRevision
      : null,
    lastActivityAt:
      typeof input?.activityAt === "string" ? input.activityAt : null,
    activityEventId:
      typeof input?.activityEventId === "string" ? input.activityEventId : null,
    owner:
      owner &&
      typeof owner === "object" &&
      typeof owner.provider === "string" &&
      typeof owner.providerSessionKey === "string" &&
      typeof owner.nativeSessionId === "string"
        ? {
            provider: owner.provider,
            providerSessionKey: owner.providerSessionKey,
            nativeSessionId: owner.nativeSessionId,
          }
        : null,
    observedAt,
    activeWorkCount: 0,
    unknownWorkCount: 1,
    sources: [],
    blockers: [sanitizeCode(code)],
  };
}

function sourceResult(id) {
  return {
    id,
    inventoryComplete: true,
    activeWorkCount: 0,
    unknownWorkCount: 0,
    truncated: false,
    observed: {},
    code: null,
  };
}

function unknown(result, code) {
  result.inventoryComplete = false;
  result.unknownWorkCount += 1;
  result.code = sanitizeCode(code);
  result.observed = { ...result.observed, blocker: result.code };
  return result;
}

function storeSummary(read, count, cap) {
  return {
    path: read.path,
    sha256: read.sha256,
    mtime: read.mtime,
    size: read.size,
    count,
    cap,
    truncated: Number.isSafeInteger(cap) && count >= cap,
  };
}

function readDirectory(directory, cap) {
  const pathInfo = inspectPath(directory);
  if (pathInfo.missing) return { missing: true, entries: [], truncated: false };
  if (!pathInfo.directory) throw errorCode("DIRECTORY_PATH_UNSAFE");
  const before = fs.lstatSync(directory);
  const entries = [];
  const handle = fs.opendirSync(directory);
  try {
    while (entries.length <= cap) {
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  const after = fs.lstatSync(directory);
  if (!sameStat(before, after))
    throw errorCode("DIRECTORY_CHANGED_DURING_READ");
  const truncated = entries.length > cap;
  const retained = entries.slice(0, cap);
  const names = retained.map((entry) => entry.name).sort();
  const namesHash = hashText(names.join("\n"));
  return {
    missing: false,
    entries: retained,
    truncated,
    mtime: after.mtime.toISOString(),
    namesHash,
    totalEntries: truncated ? null : entries.length,
  };
}

function assertSafeDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw errorCode("DIRECTORY_PATH_NOT_ABSOLUTE");
  }
  const info = inspectPath(directory);
  if (info.missing || !info.directory)
    throw errorCode("DIRECTORY_MISSING_OR_UNSAFE");
}

function ensureSafeDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw errorCode("DIRECTORY_PATH_NOT_ABSOLUTE");
  }
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const parts = resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw errorCode("DIRECTORY_PATH_UNSAFE");
    }
  }
}

function inspectPath(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const parts = resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;
  let last = null;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return { missing: true, directory: false };
      throw error;
    }
    if (stat.isSymbolicLink()) throw errorCode("PATH_SYMLINK_OR_JUNCTION");
    last = stat;
  }
  if (!last) {
    last = fs.lstatSync(parsed.root);
  }
  return {
    missing: false,
    directory: last.isDirectory(),
    file: last.isFile(),
    stat: last,
  };
}

function existsWithoutFollowingLink(file) {
  const info = inspectPath(file);
  return !info.missing;
}

function readStableFile(file, maxBytes) {
  const beforePath = inspectPath(file);
  if (beforePath.missing) return null;
  if (!beforePath.file) throw errorCode("FILE_PATH_UNSAFE");
  if (beforePath.stat.size > maxBytes) throw errorCode("FILE_SIZE_LIMIT");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(file, flags);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameStat(beforePath.stat, opened)) {
      throw errorCode("FILE_CHANGED_BEFORE_READ");
    }
    if (opened.size > maxBytes) throw errorCode("FILE_SIZE_LIMIT");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const afterPath = inspectPath(file);
    if (
      !afterPath.file ||
      !sameStat(opened, after) ||
      !sameStat(after, afterPath.stat) ||
      bytes.length !== after.size
    ) {
      throw errorCode("FILE_CHANGED_DURING_READ");
    }
    return {
      path: path.resolve(file),
      bytes,
      size: bytes.length,
      sha256: sha256(bytes),
      mtime: after.mtime.toISOString(),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
  } catch {
    throw errorCode(code);
  }
}

function boundedObject(value, maxBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return bytes.length <= maxBytes ? value : null;
}

function hashBoundedObject(value, maxBytes) {
  const bounded = boundedObject(value, maxBytes);
  if (!bounded) return null;
  return sha256(Buffer.from(JSON.stringify(bounded), "utf8"));
}

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validStatus(value) {
  return (
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
  );
}

function normalizedStatus(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function hashText(value) {
  return sha256(Buffer.from(value, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function errorCode(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error) {
  return sanitizeCode(error?.code || "SOURCE_READ_FAILED");
}

function sanitizeCode(value) {
  return typeof value === "string" && /^[A-Z0-9_-]{1,80}$/.test(value)
    ? value
    : "SOURCE_READ_FAILED";
}
