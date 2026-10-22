import fs from "node:fs";
import path from "node:path";
import { createTaskManager } from "./manager.mjs";
import { OtmError } from "./errors.mjs";
import { sha256, shortHash } from "./ids.mjs";
import { redactSensitiveText } from "./validation.mjs";
import { readSharedHistoryPage } from "./shared-history.mjs";
import {
  assertContinuationEligible,
  evaluateContinuation,
  findPendingWork,
  findPendingWorkEntries,
  HOST_CONTINUATION_EVIDENCE_SCHEMA,
  HOST_CONTINUATION_REQUIRED_SOURCES,
  validateHostContinuationEvidence,
} from "./continuation.mjs";
import { readOwnerWorkEvidence } from "./work-evidence.mjs";
import {
  createProviderEnvironment,
  createProviderSession,
  createVerifiedProviderSession,
} from "./provider-session.mjs";

export const PROVIDER_ADAPTER_API_VERSION = "otm.provider-adapter.v1";

const SESSION_IDENTITY_FIELDS = Object.freeze([
  "sessionId",
  "session_id",
  "threadId",
  "thread_id",
  "conversationId",
  "conversation_id",
]);

const CLAUDE_HOST_EVENTS = new Set([
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

/**
 * Create a provider-scoped facade over the existing OTM manager. The provider
 * and native session id must come from a trusted host request context, never
 * from ordinary tool arguments.
 */
export function createProviderAdapter({
  provider,
  nativeSessionId,
  workspaceRoot,
  cwd,
  env = process.env,
  store,
  readOnly = false,
  inspectOwnerWork = null,
  verifiedSessionClaims = null,
} = {}) {
  const session = verifiedSessionClaims
    ? createVerifiedProviderSession(verifiedSessionClaims)
    : createProviderSession({ provider, nativeSessionId });
  const trustedNativeSessionId = verifiedSessionClaims
    ? verifiedSessionClaims.nativeSessionId
    : nativeSessionId;
  if (provider !== session.provider) {
    throw new OtmError(
      "Provider identity does not match its trusted session context.",
      { code: "PROVIDER_IDENTITY_CONFLICT" },
    );
  }
  if (verifiedSessionClaims && nativeSessionId !== undefined) {
    throw new OtmError(
      "A signed Claude capability cannot be combined with a native session id.",
      { code: "PROVIDER_SESSION_MISMATCH" },
    );
  }
  const scopedEnv = createProviderEnvironment(env);
  const ownsStore = !store;
  const manager = createTaskManager({
    cwd: cwd || workspaceRoot,
    env: scopedEnv,
    readOnly,
    ...(store ? { store } : {}),
  });

  function withScope(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new OtmError("Provider operation arguments must be an object.", {
        code: "INVALID_INPUT",
      });
    }

    for (const field of SESSION_IDENTITY_FIELDS) {
      const candidate = normalizeIdentity(input[field]);
      if (
        candidate &&
        candidate !== session.sessionId &&
        candidate !== normalizeIdentity(nativeSessionId)
      ) {
        throw new OtmError(
          "The operation session does not match its trusted provider context.",
          {
            code: "PROVIDER_SESSION_MISMATCH",
            details: { provider: session.provider, field },
          },
        );
      }
    }
    if (input.provider !== undefined && input.provider !== session.provider) {
      throw new OtmError(
        "Provider identity is fixed by the trusted adapter context.",
        {
          code: "PROVIDER_IDENTITY_CONFLICT",
          details: { provider: session.provider },
        },
      );
    }

    const args = { ...input };
    for (const field of SESSION_IDENTITY_FIELDS) delete args[field];
    delete args.provider;
    return {
      ...args,
      sessionId: session.sessionId,
      ...(input.workspaceRoot || workspaceRoot
        ? { workspaceRoot: input.workspaceRoot || workspaceRoot }
        : {}),
    };
  }

  function scopedRun(input = {}) {
    const args = withScope(input);
    if (typeof args.runId !== "string" || !args.runId.trim()) {
      throw new OtmError("runId is required for this provider operation.", {
        code: "RUN_ID_REQUIRED",
      });
    }
    const result = manager.snapshot({ ...args, write: false });
    if (!result.run || result.run.id !== args.runId) {
      throw new OtmError(
        "The requested route is not available to this provider session.",
        {
          code: "PROVIDER_RUN_SCOPE_MISMATCH",
        },
      );
    }
    return { args, result };
  }

  function providerContext() {
    return {
      provider: session.provider,
      providerSessionKey: session.providerSessionKey,
      nativeSessionId: normalizeIdentity(trustedNativeSessionId),
    };
  }

  function recordProviderEvent(input, eventType, payload, operationId) {
    const { args, result } = scopedRun(input);
    if (
      payload.taskId &&
      !result.snapshot.tasks.some((task) => task.id === payload.taskId)
    ) {
      throw new OtmError("taskId is not a route gate in the requested run.", {
        code: "TASK_NOT_FOUND",
      });
    }
    const operationHash = normalizeOperationId(operationId);
    return manager.recordOwnedEvent({
      runId: result.run.id,
      sessionId: args.sessionId,
      expectedRevision: result.run.routeRevision,
      eventType,
      payload: {
        ...payload,
        provider: session.provider,
        providerSessionKey: session.providerSessionKey,
      },
      context: operationHash
        ? { operationId: operationHash, turnId: args.turnId }
        : {},
    });
  }

  function checkpoint(input = {}) {
    const { result } = scopedRun(input);
    const { run, snapshot } = result;
    const requiredTasks = snapshot.tasks.filter((task) => task.required);
    const terminal = new Set(["done", "dropped", "superseded"]);
    const completedCount = requiredTasks.filter((task) =>
      terminal.has(task.status),
    ).length;
    const nextTask = requiredTasks.find((task) => !terminal.has(task.status));
    const currentTask = snapshot.currentTask || null;
    const body = [
      "Shared OTM checkpoint recorded in the canonical route history.",
      `Run: ${run.id}`,
      `Status: ${run.status}`,
      `Route revision: ${run.routeRevision}`,
      `Required route gates terminal: ${completedCount}/${requiredTasks.length}`,
      `Current task id: ${currentTask?.id || "none"}`,
      `Next required task id: ${nextTask?.id || "none"}`,
      "A different provider can read this same route and its summary history.",
    ].join("\n");
    const checkpointKey =
      typeof input.checkpointKey === "string" && input.checkpointKey.trim()
        ? shortHash(input.checkpointKey.trim(), 24)
        : "latest";
    const event = manager.recordOwnedEvent({
      runId: run.id,
      sessionId: result.run.sessionId,
      expectedRevision: run.routeRevision,
      eventType: "provider_checkpoint_recorded",
      payload: {
        provider: session.provider,
        providerSessionKey: session.providerSessionKey,
        routeRevision: run.routeRevision,
        checkpointKey,
        markdown: body,
      },
      context: { operationId: `checkpoint:${run.id}:${checkpointKey}` },
    });
    return { checkpoint: body, event };
  }

  function recordSubagentOwnership(input = {}) {
    assertInputObject(input);
    const workerProvider = input.workerProvider || session.provider;
    if (workerProvider !== session.provider) {
      throw new OtmError(
        "Cross-provider subagent ownership is not supported.",
        {
          code: "CROSS_PROVIDER_OPERATION_FORBIDDEN",
          details: {
            ownerProvider: session.provider,
          },
        },
      );
    }
    const worker = createProviderSession({
      provider: session.provider,
      nativeSessionId: input.workerNativeSessionId,
    });
    const { args, result } = scopedRun(input);
    if (!result.snapshot.tasks.some((task) => task.id === input.taskId)) {
      throw new OtmError("taskId is not a route gate in the requested run.", {
        code: "TASK_NOT_FOUND",
      });
    }
    return manager.recordOwnedEvent({
      runId: result.run.id,
      sessionId: args.sessionId,
      expectedRevision: result.run.routeRevision,
      eventType: "provider_subagent_ownership_recorded",
      payload: {
        provider: session.provider,
        providerSessionKey: session.providerSessionKey,
        ownerProvider: session.provider,
        ownerSessionKey: session.providerSessionKey,
        workerProvider: session.provider,
        workerSessionKey: worker.providerSessionKey,
        taskId: input.taskId,
      },
      context: normalizeOperationId(input.operationId)
        ? {
            operationId: normalizeOperationId(input.operationId),
            turnId: args.turnId,
          }
        : {},
    });
  }

  function observeHostHook(input = {}) {
    assertInputObject(input);
    const eventName = input.eventName;
    const payload = input.payload;
    if (!CLAUDE_HOST_EVENTS.has(eventName) || session.provider !== "claude") {
      throw new OtmError(
        "Host hook observation is not supported for this provider event.",
        {
          code: "UNSUPPORTED_PROVIDER_HOOK_EVENT",
        },
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new OtmError("Host hook payload must be an object.", {
        code: "INVALID_PROVIDER_HOOK_PAYLOAD",
      });
    }
    if (
      payload.hook_event_name !== eventName ||
      payload.session_id !== nativeSessionId
    ) {
      throw new OtmError(
        "Host hook identity does not match its trusted provider context.",
        {
          code: "PROVIDER_SESSION_MISMATCH",
        },
      );
    }
    if (eventName === "Stop" && payload.stop_hook_active === true) {
      return { skipped: true, reason: "stop_hook_active loop guard" };
    }
    const current = manager.snapshot({
      workspaceRoot: input.workspaceRoot || workspaceRoot,
      sessionId: session.sessionId,
      write: false,
    });
    if (!current.run)
      return { recorded: false, reason: "no route owned by this session" };

    const common = {
      provider: session.provider,
      providerSessionKey: session.providerSessionKey,
      ownerSessionId: session.sessionId,
      nativeSessionId: normalizeIdentity(nativeSessionId),
      hookEventName: eventName,
    };
    const observations = [
      {
        eventType: "provider_session_activity",
        payload: { ...common, activityKind: eventName },
      },
    ];
    const workId = eventName.startsWith("Subagent")
      ? safeHostId(payload.agent_id)
        ? `subagent:${payload.agent_id.trim()}`
        : null
      : safeHostId(payload.tool_use_id)
        ? `tool:${payload.tool_use_id.trim()}`
        : null;
    if (eventName === "SubagentStart" || eventName === "PreToolUse") {
      observations.push({
        eventType: "provider_host_work_started",
        payload: {
          ...common,
          workId,
          workLabel: eventName === "SubagentStart" ? "subagent" : "tool use",
        },
      });
    } else if (
      ["SubagentStop", "PostToolUse", "PostToolUseFailure"].includes(eventName)
    ) {
      observations.push({
        eventType: "provider_host_work_settled",
        payload: { ...common, workId, settlementEvent: eventName },
      });
    }
    // A tool call denied by another PreToolUse hook (or the permission system)
    // never fires PostToolUse, so its start receipt would stay open forever.
    // Claude's own transcript records the call's tool_result; treat that as
    // the same settlement PostToolUse would have produced.
    let transcriptSettledIds = [];
    // Complete owner-scoped work receipts; null only when a store cannot prove
    // completeness. Never a capped history window.
    const ownerWorkEvents =
      eventName === "Stop" || eventName === "SubagentStop"
        ? readOwnerWorkEvidence(manager.store, current.run.id, {
            ownerSessionId: session.sessionId,
            providerSessionKey: session.providerSessionKey,
          })
        : null;
    if (eventName === "Stop" || eventName === "SubagentStop") {
      const openToolIds = openToolWorkIds(ownerWorkEvents || []);
      if (openToolIds.size > 0) {
        transcriptSettledIds = toolResultsInTranscripts(
          claudeTranscriptPaths(payload, eventName),
          openToolIds,
        );
        for (const settledId of transcriptSettledIds) {
          observations.push({
            eventType: "provider_host_work_settled",
            payload: {
              ...common,
              workId: settledId,
              settlementEvent: "transcript-tool-result",
            },
          });
        }
      }
    }
    if (eventName === "Stop") {
      const inventory = claudeWorkInventory(payload);
      if (!ownerWorkEvents) {
        inventory.complete = false;
        inventory.unknownWorkCount += 1;
        inventory.inventoryReason = [
          inventory.inventoryReason,
          "durable OTM owner work receipts were unavailable or incomplete",
        ]
          .filter(Boolean)
          .join("; ");
      } else {
        const ownerEvents = ownerWorkEvents;
        // A background subagent's start receipt stays open until its
        // SubagentStop, while Claude also lists it as an active background
        // task. Count it once, as active work, not again as unknown work.
        let coveredSubagents = 0;
        const pendingWork = findPendingWorkEntries([
          ...ownerEvents,
          ...transcriptSettledIds.map((settledId) => ({
            eventType: "provider_host_work_settled",
            payload: { workId: settledId },
          })),
        ]).filter(([workId]) => {
          if (
            workId.startsWith("subagent:") &&
            coveredSubagents < inventory.activeWorkCount
          ) {
            coveredSubagents += 1;
            return false;
          }
          return true;
        });
        if (pendingWork.length > 0) {
          inventory.complete = false;
          inventory.unknownWorkCount += pendingWork.length;
          inventory.inventoryReason = [
            inventory.inventoryReason,
            `${pendingWork.length} unmatched OTM hook work receipt(s)`,
          ]
            .filter(Boolean)
            .join("; ");
        }
      }
      observations.push({
        eventType: "provider_work_inventory",
        payload: { ...common, ...inventory },
      });
    }
    if (eventName === "SessionEnd") {
      observations.push({
        eventType: "provider_session_ended",
        payload: common,
      });
    }

    const recorded = [];
    for (const observation of observations) {
      const operationId = normalizeOperationId(
        `${session.providerSessionKey}:${eventName}:${payload.tool_use_id || payload.agent_id || "session"}:${observation.eventType}:${Date.now()}`,
      );
      recorded.push(
        manager.recordOwnedEvent({
          runId: current.run.id,
          sessionId: session.sessionId,
          expectedRevision: current.run.routeRevision,
          eventType: observation.eventType,
          payload: observation.payload,
          context: { operationId },
        }),
      );
    }
    return { recorded: true, events: recorded };
  }

  function readSharedTask(input = {}) {
    assertInputObject(input);
    const run = manager.store.getRun(input.runId);
    if (!run)
      throw new OtmError("Saved run not found.", { code: "RUN_NOT_FOUND" });
    return manager.snapshotShared({
      ...input,
      workspaceRoot: run.workspaceRoot,
      write: false,
    });
  }

  function readSharedHistory(input = {}) {
    assertInputObject(input);
    return readSharedHistoryPage(
      manager.store,
      input,
      input.workspaceRoot || workspaceRoot,
    );
  }

  function continueTask(input = {}) {
    assertInputObject(input);
    const runId = input.runId;
    if (typeof runId !== "string" || !runId.trim()) {
      throw new OtmError("runId is required for explicit continuation.", {
        code: "RUN_ID_REQUIRED",
      });
    }
    const previous = readSharedTask({ runId });
    if (previous.run.sessionId === session.sessionId) {
      return { ...previous, continued: false, alreadyOwner: true };
    }
    if (!Number.isInteger(input.expectedRevision)) {
      throw new OtmError(
        "expectedRevision is required for explicit route continuation.",
        {
          code: "EXPECTED_REVISION_REQUIRED",
        },
      );
    }
    const events = readOwnerWorkEvidence(manager.store, runId, {
      ownerSessionId: previous.run.sessionId,
      providerSessionKey:
        previous.run.metadata?.providerSession?.providerSessionKey,
    });
    if (!events) {
      throw new OtmError(
        "The prior route's owner work receipts are incomplete, so its host work cannot be proved settled. Inspect the full durable owner history and use an explicit host recovery path before continuing.",
        { code: "OWNER_WORK_UNKNOWN" },
      );
    }
    const activityEvent = findLastOwnerActivityEvent(events, previous.run);
    let hostEvidence = null;
    if (typeof inspectOwnerWork === "function") {
      hostEvidence = inspectOwnerWork({
        schemaVersion: HOST_CONTINUATION_EVIDENCE_SCHEMA,
        run: previous.run,
        runId: previous.run.id,
        workspaceRoot: previous.run.workspaceRoot,
        routeRevision: previous.run.routeRevision,
        ownerSession: previous.run.metadata?.providerSession || null,
        activityAt: activityEvent?.createdAt || null,
        activityEventId: activityEvent?.id || null,
        requiredSources: HOST_CONTINUATION_REQUIRED_SOURCES,
        events,
      });
      if (hostEvidence && typeof hostEvidence.then === "function") {
        throw new OtmError(
          "Host evidence inspector must return a synchronous durable snapshot.",
          {
            code: "HOST_EVIDENCE_INSPECTOR_INVALID",
          },
        );
      }
    }
    const eligibility = assertContinuationEligible(
      evaluateContinuation({
        run: previous.run,
        events,
        hostEvidence,
      }),
    );
    if (previous.run.routeRevision !== input.expectedRevision) {
      throw new OtmError("Route revision changed before continuation.", {
        code: "REVISION_CONFLICT",
        details: {
          expectedRevision: input.expectedRevision,
          currentRevision: previous.run.routeRevision,
        },
      });
    }
    const result = manager.transferRunOwnership({
      runId,
      fromSessionId: previous.run.sessionId,
      toSessionId: session.sessionId,
      expectedRevision: previous.run.routeRevision,
      fromProviderSessionKey:
        previous.run.metadata.providerSession.providerSessionKey,
      toProviderSessionKey: session.providerSessionKey,
      expectedOwnerActivityEventId: eligibility.lastActivityEventId,
      evidenceSource: eligibility.evidenceSource,
      evidenceObservedAt: eligibility.evidenceObservedAt,
      evidenceRefs: eligibility.evidenceRefs,
      toProviderContext: providerContext(),
      operationId: `continue:${runId}:${input.expectedRevision}:${session.providerSessionKey}`,
    });
    return { ...result, continued: true, eligibility };
  }

  function inspectOwnedWork(input = {}) {
    assertInputObject(input);
    const { args, result } = scopedRun(input);
    const run = result.run;
    const owner = run.metadata?.providerSession;
    if (
      !owner?.provider ||
      !owner?.providerSessionKey ||
      !owner?.nativeSessionId ||
      owner.provider !== session.provider ||
      owner.providerSessionKey !== session.providerSessionKey ||
      owner.nativeSessionId !== trustedNativeSessionId
    ) {
      return { complete: false, code: "OWNER_ACTIVITY_UNKNOWN" };
    }
    const ownerEvents = readOwnerWorkEvidence(manager.store, run.id, {
      ownerSessionId: run.sessionId,
      providerSessionKey: owner.providerSessionKey,
    });
    if (!ownerEvents) {
      return { complete: false, code: "OTM_EVENT_HISTORY_INCOMPLETE" };
    }
    const activityEvent = findLastOwnerActivityEvent(ownerEvents, run);
    if (!activityEvent)
      return { complete: false, code: "OWNER_ACTIVITY_UNKNOWN" };
    const pendingWork = findPendingWork(ownerEvents);
    if (pendingWork.length) {
      return {
        complete: false,
        code: "HOST_WORK_PENDING",
        activeWorkCount: pendingWork.length,
        unknownWorkCount: 0,
      };
    }
    if (typeof inspectOwnerWork !== "function") {
      return { complete: false, code: "HOST_INSPECTOR_UNAVAILABLE" };
    }
    const hostEvidence = inspectOwnerWork({
      schemaVersion: HOST_CONTINUATION_EVIDENCE_SCHEMA,
      run,
      runId: run.id,
      workspaceRoot: args.workspaceRoot || run.workspaceRoot,
      routeRevision: run.routeRevision,
      ownerSession: owner,
      activityAt: activityEvent.createdAt,
      activityEventId: activityEvent.id,
      requiredSources: HOST_CONTINUATION_REQUIRED_SOURCES,
      events: ownerEvents,
    });
    if (hostEvidence && typeof hostEvidence.then === "function") {
      return { complete: false, code: "HOST_INSPECTOR_INVALID" };
    }
    const validated = validateHostContinuationEvidence(hostEvidence, {
      run,
      owner,
      lastActivityAt: activityEvent.createdAt,
      lastActivityEventId: activityEvent.id,
    });
    if (!validated) {
      const blocker = hostEvidence?.blockers?.find(
        (value) =>
          typeof value === "string" && /^[A-Z][A-Z0-9_-]{1,79}$/.test(value),
      );
      return { complete: false, code: blocker || "OWNER_WORK_UNKNOWN" };
    }
    return {
      complete: true,
      activeWorkCount: validated.activeWorkCount,
      unknownWorkCount: validated.unknownWorkCount,
      evidenceObservedAt: validated.observedAt,
      evidenceRefs: validated.evidenceRefs,
      code: null,
    };
  }

  function recordUsageAttribution(input = {}) {
    assertInputObject(input);
    const workerProvider = input.workerProvider || session.provider;
    if (workerProvider !== session.provider) {
      throw new OtmError("Cross-provider usage attribution is not supported.", {
        code: "CROSS_PROVIDER_OPERATION_FORBIDDEN",
        details: {
          ownerProvider: session.provider,
        },
      });
    }
    const workerSession = input.workerNativeSessionId
      ? createProviderSession({
          provider: session.provider,
          nativeSessionId: input.workerNativeSessionId,
        })
      : null;
    const usage = normalizeUsage(input);
    const payload = {
      eventKind: "provider_usage_attribution",
      role: input.role === "subagent" ? "subagent" : "root",
      runId: input.runId,
      taskId: input.taskId || null,
      workerSessionKey: workerSession?.providerSessionKey || null,
      modelId: sanitizeLabel(input.modelId, 120),
      effort: sanitizeLabel(input.effort, 60),
      startedAt: normalizeTimestamp(input.startedAt),
      endedAt: normalizeTimestamp(input.endedAt),
      durationMs: optionalCount(input.durationMs, "durationMs"),
      inputTokens: optionalCount(input.inputTokens, "inputTokens"),
      outputTokens: optionalCount(input.outputTokens, "outputTokens"),
      toolInvocationCount: optionalCount(
        input.toolInvocationCount,
        "toolInvocationCount",
      ),
      retryCount: optionalCount(input.retryCount, "retryCount"),
      contextCompactions: optionalCount(
        input.contextCompactions,
        "contextCompactions",
      ),
      outcome: sanitizeLabel(input.outcome, 300),
      apiEquivalentCostUsdEstimate: optionalNonnegativeNumber(
        input.apiEquivalentCostUsdEstimate,
        "apiEquivalentCostUsdEstimate",
      ),
      usageEvidenceRef: sanitizeLabel(input.usageEvidenceRef, 200),
      usage,
    };
    return recordProviderEvent(
      input,
      "provider_usage_attributed",
      payload,
      input.operationId,
    );
  }

  function normalizeUsage(input) {
    if (input.usage === undefined || input.usage === null) return null;
    if (
      !input.usage ||
      typeof input.usage !== "object" ||
      Array.isArray(input.usage)
    ) {
      throw new OtmError("usage must be an object when supplied.", {
        code: "INVALID_USAGE_ATTRIBUTION",
      });
    }
    return Object.fromEntries(
      Object.entries(input.usage).map(([key, value]) => {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) {
          throw new OtmError("usage contains an invalid field name.", {
            code: "INVALID_USAGE_ATTRIBUTION",
          });
        }
        if (value === null) return [key, null];
        if (typeof value === "number") {
          if (!Number.isFinite(value) || value < 0) {
            throw new OtmError(
              "usage values must be finite and non-negative.",
              {
                code: "INVALID_USAGE_ATTRIBUTION",
              },
            );
          }
          return [key, value];
        }
        if (typeof value === "string") return [key, sanitizeLabel(value, 200)];
        if (typeof value === "boolean") return [key, value];
        throw new OtmError("usage values must be scalar observations.", {
          code: "INVALID_USAGE_ATTRIBUTION",
        });
      }),
    );
  }

  return Object.freeze({
    apiVersion: PROVIDER_ADAPTER_API_VERSION,
    continuationEvidenceSchema: HOST_CONTINUATION_EVIDENCE_SCHEMA,
    provider: session.provider,
    session: Object.freeze({
      provider: session.provider,
      sessionId: session.sessionId,
      providerSessionKey: session.providerSessionKey,
    }),
    startTask: (args) =>
      manager.start({ ...withScope(args), providerContext: providerContext() }),
    reconcileTask: (args) => manager.reconcile(withScope(args)),
    markTaskActive: (args) => manager.markTaskActive(withScope(args)),
    recordProgress: (args) => manager.progress(withScope(args)),
    recordEvidence: (args) => {
      if (!args?.evidence || typeof args.evidence !== "object") {
        throw new OtmError("evidence is required.", {
          code: "INVALID_INPUT",
        });
      }
      return manager.progress(withScope(args));
    },
    completeTask: (args) => manager.completeTask(withScope(args)),
    blockTask: (args) => manager.blockTask(withScope(args)),
    auditStop: (args) =>
      manager.auditStop({ ...withScope(args), write: false }),
    finalizeTurn: (args) => manager.finalizeTurn(withScope(args)),
    checkpoint,
    resumeRun: (args) => manager.resumeRun(withScope(args)),
    snapshot: (args = {}) =>
      args.sharedReadOnly === true
        ? manager.snapshotShared({ ...withScope(args), write: false })
        : manager.snapshot(withScope(args)),
    readSharedTask,
    readSharedHistory,
    continueTask,
    inspectOwnedWork,
    observeHostHook,
    recordSubagentOwnership,
    searchProjectMemory: (args) => manager.searchMemory(withScope(args)),
    recordUsageAttribution,
    close: () => (ownsStore ? manager.close() : undefined),
  });
}

function normalizeIdentity(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new OtmError("Provider session identifiers must be strings.", {
      code: "INVALID_PROVIDER_SESSION",
    });
  }
  return value.trim() || null;
}

function findLastOwnerActivityEvent(events, run) {
  const owner = run.metadata?.providerSession;
  return (
    [...events]
      .reverse()
      .find(
        (event) =>
          event.eventType === "provider_session_activity" &&
          event.payload?.ownerSessionId === run.sessionId &&
          event.payload?.providerSessionKey === owner?.providerSessionKey,
      ) || null
  );
}

function safeHostId(value) {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 256
  );
}

const MAX_TRANSCRIPT_SCAN_BYTES = 128 * 1024 * 1024;

function openToolWorkIds(events) {
  const open = new Set();
  for (const event of events) {
    const workId = event?.payload?.workId;
    if (typeof workId !== "string" || !workId.startsWith("tool:")) continue;
    if (event.eventType === "provider_host_work_started") open.add(workId);
    else if (event.eventType === "provider_host_work_settled")
      open.delete(workId);
  }
  return open;
}

/**
 * Host-supplied transcript paths for this event: the session transcript plus
 * its subagent transcripts on Stop, or the subagent's own transcript on
 * SubagentStop. Only absolute regular .jsonl files are accepted.
 */
function claudeTranscriptPaths(payload, eventName) {
  const candidates = [];
  const main = payload.transcript_path;
  if (eventName === "SubagentStop" && payload.agent_transcript_path)
    candidates.push(payload.agent_transcript_path);
  if (typeof main === "string" && main) {
    candidates.push(main);
    if (eventName === "Stop") {
      const subagentDir = path.join(main.replace(/\.jsonl$/i, ""), "subagents");
      try {
        for (const name of fs.readdirSync(subagentDir))
          if (/\.jsonl$/i.test(name))
            candidates.push(path.join(subagentDir, name));
      } catch {
        /* no subagents */
      }
    }
  }
  return candidates.filter((file) => {
    if (typeof file !== "string" || !path.isAbsolute(file)) return false;
    if (!/\.jsonl$/i.test(file)) return false;
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function toolResultsInTranscripts(files, openToolIds) {
  const wanted = new Map(
    [...openToolIds].map((workId) => [workId.slice("tool:".length), workId]),
  );
  const settled = new Set();
  for (const file of files) {
    if (settled.size === wanted.size) break;
    let text;
    try {
      if (fs.statSync(file).size > MAX_TRANSCRIPT_SCAN_BYTES) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"tool_result"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const content = record?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        const workId = wanted.get(block.tool_use_id);
        if (workId) settled.add(workId);
      }
    }
  }
  return [...settled];
}

function claudeWorkInventory(payload) {
  const listsPresent =
    Array.isArray(payload.background_tasks) &&
    Array.isArray(payload.session_crons);
  if (!listsPresent) {
    return {
      source: "claude-stop-hook",
      complete: false,
      activeWorkCount: 0,
      unknownWorkCount: 1,
      inventoryReason:
        "official background_tasks or session_crons field was absent",
    };
  }
  let activeWorkCount = 0;
  let unknownWorkCount = 0;
  for (const item of [...payload.background_tasks, ...payload.session_crons]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      unknownWorkCount += 1;
      continue;
    }
    const status = String(item.status || item.state || "").toLowerCase();
    if (
      [
        "completed",
        "complete",
        "succeeded",
        "failed",
        "errored",
        "cancelled",
        "canceled",
        "stopped",
      ].includes(status)
    )
      continue;
    if (
      [
        "queued",
        "pending",
        "running",
        "working",
        "scheduled",
        "active",
      ].includes(status)
    )
      activeWorkCount += 1;
    else unknownWorkCount += 1;
  }
  return {
    source: "claude-stop-hook",
    complete: unknownWorkCount === 0,
    activeWorkCount,
    unknownWorkCount,
  };
}

function assertInputObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OtmError("Provider operation arguments must be an object.", {
      code: "INVALID_INPUT",
    });
  }
  return input;
}

function normalizeOperationId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new OtmError("operationId must be a string.", {
      code: "INVALID_INPUT",
    });
  }
  if (value.length > 512) {
    throw new OtmError("operationId exceeds the maximum length.", {
      code: "INPUT_TOO_LARGE",
    });
  }
  return sha256(value).slice(0, 32);
}

function sanitizeLabel(value, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new OtmError("Provider attribution labels must be strings.", {
      code: "INVALID_INPUT",
    });
  }
  const sanitized = redactSensitiveText(value.trim()).slice(0, maxLength);
  return sanitized || null;
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new OtmError("Usage timestamps must be valid date strings.", {
      code: "INVALID_USAGE_ATTRIBUTION",
    });
  }
  return new Date(value).toISOString();
}

function optionalCount(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OtmError(`${name} must be a non-negative safe integer.`, {
      code: "INVALID_USAGE_ATTRIBUTION",
      details: { field: name },
    });
  }
  return value;
}

function optionalNonnegativeNumber(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new OtmError(`${name} must be a finite non-negative number.`, {
      code: "INVALID_USAGE_ATTRIBUTION",
      details: { field: name },
    });
  }
  return value;
}
