import path from "node:path";
import { createStore } from "../storage/store.mjs";
import { assertCondition, OtmError } from "./errors.mjs";
import { newId, nowIso, sha256, stableTaskKey, shortHash } from "./ids.mjs";
import {
  cleanupWorkspaceStateTempFiles,
  findWorkspaceRoot,
  workspaceStateDir,
  ensureDir,
  summariesDir,
  atomicWriteJson,
  atomicWriteText,
  currentJsonPath,
  currentMarkdownPath,
  removeFileIfExists,
  workspaceTempDir,
  readOtmJsonArtifact,
} from "./fs-utils.mjs";
import {
  buildSnapshot,
  renderSnapshotMarkdown,
  renderSummaryMarkdown,
  renderDeltaMarkdown,
  writeCurrentFiles,
  writeWorkspaceCurrentIndex,
} from "./renderer.mjs";
import { combinePromptContext, planFallbackRoute } from "./planner.mjs";
import {
  CURRENT_SCHEMA_VERSION,
  MANAGER_NAME,
  RUN_STATUSES,
  TASK_STATUSES,
} from "./constants.mjs";
import { resolveSessionId } from "./session-scope.mjs";
import { assertRunTransition, assertTaskTransition } from "./state-machine.mjs";
import {
  LIMITS,
  assertAcyclicContext,
  assertKnownEnum,
  assertNonEmptyString,
  assertUniqueIds,
  canonicalizeWorkspaceRoot,
  redactSensitiveText,
  safeGeneratedFileId,
  workspaceIdentity,
} from "./validation.mjs";
import { tokenize } from "./text-utils.mjs";

const DEFAULT_HISTORY_RETENTION_DAYS = 7;

export function createTaskManager(options = {}) {
  const env = options.env || process.env;
  const store =
    options.store || createStore({ env, readOnly: options.readOnly === true });

  function resolveWorkspace(cwdOrRoot) {
    return canonicalizeWorkspaceRoot(cwdOrRoot || options.cwd || process.cwd())
      .displayPath;
  }

  function recordEvent(runId, eventType, payload = {}, context = {}) {
    const event = buildEvent(runId, eventType, payload, context);
    store.recordEvent(event);
    return event;
  }

  function buildEvent(runId, eventType, payload = {}, context = {}) {
    return {
      id: newId("evt"),
      runId,
      turnId: context.turnId || payload.turnId || null,
      hookEventName: context.hookEventName || payload.hookEventName || null,
      eventType,
      idempotencyKey:
        context.idempotencyKey ||
        context.operationId ||
        context.invocationId ||
        context.toolUseId ||
        `${runId}:${eventType}:${shortHash(JSON.stringify(payload))}`,
      payload,
      createdAt: nowIso(),
    };
  }

  function commitRunMutation(
    run,
    tasks,
    eventType,
    payload,
    context = {},
    summaries = [],
    newTasks = [],
  ) {
    const next = store.commitRunMutation({
      run,
      expectedRevision: Number(run.routeRevision || 1) - 1,
      tasks,
      newTasks,
      summaries,
      event: buildEvent(run.id, eventType, payload, context),
    });
    return next;
  }

  function getScopedActiveRun(
    workspaceRoot,
    sessionId,
    { claimLegacy = true } = {},
  ) {
    let run = store.getActiveRun(workspaceRoot, sessionId);
    if (
      !run &&
      sessionId &&
      claimLegacy &&
      env.OTM_CLAIM_LEGACY_ROUTE === "1"
    ) {
      run = store.claimLegacyActiveRun(workspaceRoot, sessionId, {
        legacySessionClaimedAt: nowIso(),
      });
      if (run) {
        recordEvent(
          run.id,
          "legacy_session_claimed",
          { sessionId },
          { sessionId },
        );
      }
    }
    return run;
  }

  function getRunOrActive({ runId, workspaceRoot, sessionId }) {
    if (runId) {
      const run = store.getRun(runId);
      assertCondition(run, `Run not found: ${runId}`, "RUN_NOT_FOUND");
      assertCondition(
        sameWorkspace(run.workspaceRoot, workspaceRoot),
        "Run belongs to a different workspace.",
        "WORKSPACE_SCOPE_MISMATCH",
      );
      // An explicit id is never an authority bypass. In particular, an
      // identity-less caller must not gain access merely by knowing a scoped
      // route id. Legacy adoption is deliberately confined to
      // getScopedActiveRun and requires OTM_CLAIM_LEGACY_ROUTE=1.
      assertCondition(
        !run.sessionId || (Boolean(sessionId) && run.sessionId === sessionId),
        "Run belongs to a different Codex session.",
        "SESSION_SCOPE_MISMATCH",
        { requestedRunId: runId, runScoped: Boolean(run.sessionId) },
      );
      return run;
    }
    const run = getScopedActiveRun(workspaceRoot, sessionId);
    assertCondition(
      run,
      "No active Overtli Task Manager route exists for this workspace and Codex session.",
      "NO_ACTIVE_RUN",
    );
    return run;
  }

  function assertExpectedRevision(run, args = {}) {
    if (args.expectedRevision === undefined || args.expectedRevision === null)
      return;
    const expected = Number(args.expectedRevision);
    assertCondition(
      Number.isInteger(expected) && expected === Number(run.routeRevision),
      "Route revision conflict.",
      "REVISION_CONFLICT",
      {
        expectedRevision: expected,
        currentRevision: run.routeRevision,
        runId: run.id,
      },
    );
  }

  function normalizeTask(input, runId, sortOrder, createdBy = "manual") {
    assertCondition(
      input && typeof input === "object" && !Array.isArray(input),
      "Task must be an object.",
      "INVALID_TASK",
    );
    const title = assertNonEmptyString(input.title, "task title", LIMITS.title);
    const acceptanceCriteria =
      Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length
        ? normalizeBoundedStrings(
            input.acceptanceCriteria,
            "acceptance criteria",
            128,
            2_000,
          )
        : ["Complete this route segment with concrete evidence."];
    assertCondition(
      input.acceptanceCriteria === undefined ||
        Array.isArray(input.acceptanceCriteria),
      "acceptanceCriteria must be an array.",
      "INVALID_INPUT",
    );
    const taskId =
      input.id === undefined
        ? newId("task")
        : assertNonEmptyString(String(input.id), "task id", LIMITS.id);
    const stableKey =
      input.stableKey === undefined
        ? stableTaskKey(title, acceptanceCriteria)
        : assertNonEmptyString(String(input.stableKey), "task stableKey", 256);
    const priority = normalizeBoundedInteger(
      input.priority,
      50,
      0,
      1_000,
      "task priority",
    );
    const normalizedSortOrder = normalizeBoundedInteger(
      input.sortOrder,
      sortOrder,
      0,
      100_000,
      "task sortOrder",
    );
    const description =
      input.description === undefined ||
      input.description === null ||
      String(input.description).trim() === ""
        ? null
        : assertNonEmptyString(
            String(input.description),
            "task description",
            LIMITS.text,
          );
    const evidence =
      input.evidence === undefined ? [] : normalizeTaskEvidence(input.evidence);
    const metadata = normalizeTaskMetadata(input, acceptanceCriteria);
    return {
      id: taskId,
      runId,
      parentId:
        input.parentId === undefined || input.parentId === null
          ? null
          : assertNonEmptyString(
              String(input.parentId),
              "task parentId",
              LIMITS.id,
            ),
      stableKey,
      title,
      description,
      // Route creation is intentionally non-trusting: terminal/blocked states
      // must be produced through explicit domain transitions, never prompt data.
      status:
        input.status === undefined
          ? "pending"
          : assertInitialTaskStatus(input.status),
      required: input.required !== false,
      priority,
      sortOrder: normalizedSortOrder,
      createdBy: assertNonEmptyString(String(createdBy), "task createdBy", 128),
      acceptanceCriteria,
      evidence,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      metadata: {
        ...metadata,
        dependsOn: normalizeDependsOn(input.dependsOn ?? metadata.dependsOn),
      },
    };
  }

  function mergedTask(existing, incoming, reason) {
    const existingMetadata = existing.metadata || {};
    const incomingMetadata = incoming.metadata || {};
    const metadata = mergeTaskMetadata(existingMetadata, incomingMetadata);
    const internalSteps = mergeInternalSteps(
      existingMetadata.internalSteps || [],
      incomingMetadata.internalSteps || [],
    );
    if (internalSteps.length) metadata.internalSteps = internalSteps;
    metadata.consolidatedFrom = [
      ...(Array.isArray(existingMetadata.consolidatedFrom)
        ? existingMetadata.consolidatedFrom
        : []),
      omitEmpty({
        id: incoming.id,
        title: incoming.title,
        stableKey: incoming.stableKey,
        reason,
        at: nowIso(),
      }),
    ];
    return {
      ...existing,
      required: Boolean(existing.required || incoming.required),
      priority: Math.min(
        Number(existing.priority || 50),
        Number(incoming.priority || 50),
      ),
      acceptanceCriteria: unionStrings(
        existing.acceptanceCriteria || [],
        incoming.acceptanceCriteria || [],
      ),
      metadata,
    };
  }

  function reopenedTask(existing, incoming = null, reason = "reconcile") {
    const existingMetadata = existing.metadata || {};
    const incomingMetadata = incoming?.metadata || {};
    const metadata = mergeTaskMetadata(existingMetadata, incomingMetadata);
    const internalSteps = resetInternalStepsForReopen(
      mergeInternalSteps(
        existingMetadata.internalSteps || [],
        incomingMetadata.internalSteps || [],
      ),
    );
    if (internalSteps.length) metadata.internalSteps = internalSteps;
    metadata.reopened = [
      ...(Array.isArray(existingMetadata.reopened)
        ? existingMetadata.reopened
        : []),
      omitEmpty({
        previousStatus: existing.status,
        previousCompletedAt: existing.completedAt || undefined,
        reason,
        at: nowIso(),
      }),
    ];
    const status = incoming?.status === "active" ? "active" : "pending";
    assertTaskTransition(existing.status, status, {
      taskId: existing.id,
      reason,
    });
    return {
      ...existing,
      status,
      completedAt: null,
      required: incoming
        ? Boolean(existing.required || incoming.required)
        : existing.required,
      priority: incoming
        ? Math.min(
            Number(existing.priority || 50),
            Number(incoming.priority || 50),
          )
        : existing.priority,
      acceptanceCriteria: incoming
        ? unionStrings(
            existing.acceptanceCriteria || [],
            incoming.acceptanceCriteria || [],
          )
        : existing.acceptanceCriteria,
      metadata,
    };
  }

  function snapshotForRun(run, lastUpdate = null, { write = true } = {}) {
    const tasks = store.getTasks(run.id);
    const snapshot = buildSnapshot({
      run,
      tasks,
      workspaceRoot: run.workspaceRoot,
      storageKind: store.kind,
      lastUpdate,
    });
    if (write) writeCurrentFiles(run.workspaceRoot, snapshot);
    return snapshot;
  }

  function start(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    ensureDir(workspaceStateDir(workspaceRoot));
    const active = getScopedActiveRun(workspaceRoot, sessionId);
    if (!sessionId) {
      const scopedActive = store
        .listActiveRuns(workspaceRoot)
        .filter((run) => run.sessionId);
      assertCondition(
        scopedActive.length === 0,
        "A Codex session id is required because this workspace already has session-scoped routes.",
        "SESSION_ID_REQUIRED",
      );
    }
    if (active && args.replaceExisting !== true) {
      const snapshot = snapshotForRun(active, {
        kind: "reuse_active",
        message:
          "An active route already exists. Use reconcile to update it or pass replaceExisting=true to replace it.",
        at: nowIso(),
      });
      return {
        run: active,
        snapshot,
        markdown: renderSnapshotMarkdown(snapshot),
        reused: true,
      };
    }

    const prompt = String(args.prompt || args.goal || "").trim();
    assertAcyclicContext({
      context: args.context,
      promptContext: args.promptContext,
      attachments: args.attachments,
      screenshots: args.screenshots || args.images,
    });
    const plannerPrompt =
      combinePromptContext(prompt, {
        context: args.context,
        promptContext: args.promptContext,
        attachments: args.attachments,
        screenshots: args.screenshots || args.images,
      }).trim() || prompt;
    const goal = String(
      args.goal || prompt || "Complete the requested Codex task",
    ).trim();
    const createdAt = nowIso();
    const run = {
      id: args.runId || newId("run"),
      workspaceRoot,
      sessionId,
      turnId: args.turnId || null,
      promptHash: sha256(plannerPrompt),
      goal,
      status: "active",
      routeRevision: 1,
      currentTaskId: null,
      createdAt,
      updatedAt: createdAt,
      finalizedAt: null,
      metadata: {
        gitBranch: args.gitBranch || null,
        source: args.source || "mcp",
        promptPreview: plannerPrompt.slice(0, 500),
      },
    };
    let fallbackPlan = null;
    const taskInputs =
      Array.isArray(args.tasks) && args.tasks.length
        ? args.tasks
        : (fallbackPlan = planFallbackRoute(prompt, {
            goal,
            context: args.context,
            promptContext: args.promptContext,
            attachments: args.attachments,
            screenshots: args.screenshots || args.images,
          })).tasks;
    if (fallbackPlan) run.metadata.planner = fallbackPlan.metadata;
    assertCondition(
      taskInputs.length <= 256,
      "Too many route tasks.",
      "INPUT_TOO_LARGE",
    );
    assertUniqueIds(
      taskInputs.filter((task) => task?.id),
      "task",
    );
    const tasks = taskInputs.map((task, index) =>
      normalizeTask(task, run.id, index + 1, task.createdBy || "prompt"),
    );
    assertValidDependencies(tasks);
    normalizeActiveTasks(tasks);
    run.currentTaskId =
      tasks.find((task) => task.status === "active")?.id ||
      tasks[0]?.id ||
      null;
    const startEvent = {
      id: newId("evt"),
      runId: run.id,
      turnId: args.turnId || null,
      hookEventName: args.hookEventName || null,
      eventType: "run_started",
      idempotencyKey:
        args.idempotencyKey ||
        args.operationId ||
        args.invocationId ||
        args.toolUseId ||
        `${run.id}:run_started:${shortHash(JSON.stringify({ goal, taskCount: tasks.length, promptHash: run.promptHash }))}`,
      payload: { goal, taskCount: tasks.length, promptHash: run.promptHash },
      createdAt: nowIso(),
    };
    try {
      store.createRoute({
        run,
        tasks,
        event: startEvent,
        replaceRunId:
          active && args.replaceExisting === true ? active.id : null,
      });
    } catch (error) {
      if (error?.code !== "ACTIVE_ROUTE_CONFLICT") throw error;
      const concurrent = getScopedActiveRun(workspaceRoot, sessionId, {
        claimLegacy: false,
      });
      if (!concurrent) throw error;
      const snapshot = snapshotForRun(concurrent, {
        kind: "reuse_active",
        message:
          "A concurrent start already created this session route; reusing it.",
        at: nowIso(),
      });
      return {
        run: concurrent,
        snapshot,
        markdown: renderSnapshotMarkdown(snapshot),
        reused: true,
      };
    }
    const snapshot = snapshotForRun(run, {
      kind: "run_started",
      message: `Route created with ${tasks.length} segment${tasks.length === 1 ? "" : "s"}.`,
      at: nowIso(),
    });
    return {
      run,
      snapshot,
      markdown: renderSnapshotMarkdown(snapshot),
      reused: false,
    };
  }

  function reconcile(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    assertExpectedRevision(run, args);
    const mode = args.mode || "append";
    const now = nowIso();
    const tasks = store.getTasks(run.id);
    const originalById = new Map(tasks.map((task) => [task.id, task]));
    let workingTasks = tasks.map((task) => ({
      ...task,
      metadata: { ...(task.metadata || {}) },
    }));
    let changed = 0;
    let preferredCurrentId = run.currentTaskId;
    let forcePreferredCurrent = false;

    if (mode === "replace") {
      for (const task of workingTasks) {
        if (!["done", "dropped", "superseded"].includes(task.status)) {
          assertTaskTransition(task.status, "superseded", {
            taskId: task.id,
            reason: args.prompt || null,
          });
          replaceWorkingTask({
            ...task,
            status: "superseded",
            metadata: terminalizeInternalSteps({
              ...(task.metadata || {}),
              supersededByPrompt: args.prompt || null,
            }),
          });
          changed += 1;
        }
      }
    }

    for (const change of Array.isArray(args.changes) ? args.changes : []) {
      if (change.action === "supersede" || change.action === "drop") {
        const task = store.getTask(change.taskId);
        if (task && task.runId === run.id) {
          assertCondition(
            !["done", "dropped", "superseded"].includes(task.status),
            "Completed or terminal tasks must be reopened before reconciliation can terminalize them.",
            "INVALID_TRANSITION",
          );
          const currentTask = workingTasks.find((item) => item.id === task.id);
          assertCondition(
            currentTask,
            "Task not found in active route.",
            "TASK_NOT_FOUND",
          );
          assertTaskTransition(
            currentTask.status,
            change.action === "drop" ? "dropped" : "superseded",
            { taskId: currentTask.id, reason: change.reason || null },
          );
          replaceWorkingTask({
            ...currentTask,
            status: change.action === "drop" ? "dropped" : "superseded",
            metadata: terminalizeInternalSteps({
              ...(task.metadata || {}),
              reason: change.reason || args.prompt || null,
            }),
          });
          changed += 1;
        } else if (task)
          throw new OtmError("Task belongs to a different run.", {
            code: "TASK_RUN_SCOPE_MISMATCH",
          });
        else
          throw new OtmError("Task not found in active route.", {
            code: "TASK_NOT_FOUND",
            details: { taskId: change.taskId },
          });
      } else if (change.action === "activate") {
        const task = workingTasks.find((item) => item.id === change.taskId);
        assertCondition(
          task,
          "Task not found in active route.",
          "TASK_NOT_FOUND",
        );
        assertCondition(
          ["pending", "active"].includes(task.status),
          `Cannot activate task in status ${task.status}. Resume or reopen it through its recorded lifecycle operation.`,
          "INVALID_TRANSITION",
        );
        assertTaskTransition(task.status, "active", { taskId: task.id });
        assertDependenciesTerminal(task, workingTasks);
        assertCanSwitchTask(workingTasks, task, { ...args, silent: true });
        preferredCurrentId = change.taskId;
        forcePreferredCurrent = true;
        changed += 1;
      } else if (change.action === "reopen") {
        const task = resolveTaskForReopen(change, workingTasks);
        if (task) {
          const incoming = change.title
            ? normalizeTask(change, run.id, task.sortOrder, "steering")
            : null;
          replaceWorkingTask(
            reopenedTask(
              task,
              incoming,
              change.reason || args.prompt || "change:reopen",
            ),
          );
          preferredCurrentId = task.id;
          forcePreferredCurrent = true;
          changed += 1;
        } else
          throw new OtmError("Task not found in active route.", {
            code: "TASK_NOT_FOUND",
            details: { taskId: change.taskId || null },
          });
      } else if (change.action === "add") {
        reconcileTaskInput(
          change,
          workingTasks.length + 1,
          "steering",
          change.reason || args.prompt || "change:add",
        );
        changed += 1;
      } else
        throw new OtmError(
          `Unsupported reconciliation action: ${change.action}`,
          { code: "INVALID_RECONCILIATION" },
        );
    }

    if (Array.isArray(args.tasks) && args.tasks.length) {
      for (const [index, input] of args.tasks.entries()) {
        const nextOrder = workingTasks.length + index + 1;
        reconcileTaskInput(
          input,
          nextOrder,
          input.createdBy || "steering",
          args.prompt || "reconcile:tasks",
        );
        changed += 1;
      }
    }

    assertValidDependencies(workingTasks);
    const current = chooseCurrentTask(workingTasks, preferredCurrentId, {
      forcePreferred: forcePreferredCurrent,
    });
    workingTasks = activateTaskList(workingTasks, current);
    assertTaskListTransitions(tasks, workingTasks);
    const taskUpdates = workingTasks.filter(
      (task) =>
        originalById.has(task.id) &&
        JSON.stringify(task) !== JSON.stringify(originalById.get(task.id)),
    );
    const newTasks = workingTasks.filter((task) => !originalById.has(task.id));
    const nextRunStatus = workingTasks.some((task) => task.status === "blocked")
      ? "blocked"
      : current
        ? "active"
        : "ready_to_finalize";
    assertRunTransition(run.status, nextRunStatus, { runId: run.id });
    run = commitRunMutation(
      {
        ...run,
        routeRevision: (run.routeRevision || 1) + 1,
        currentTaskId: current?.id || null,
        status: nextRunStatus,
        updatedAt: now,
      },
      taskUpdates,
      "run_reconciled",
      { mode, changed, prompt: args.prompt || null },
      args,
      [],
      newTasks,
    );
    const snapshot = snapshotForRun(run, {
      kind: "run_reconciled",
      message: changed
        ? `Route updated with ${changed} change${changed === 1 ? "" : "s"}.`
        : "Route checked. No changes were needed.",
      at: now,
    });
    return {
      run,
      snapshot,
      markdown: renderSnapshotMarkdown(snapshot),
      changed,
    };

    function replaceWorkingTask(next) {
      workingTasks = workingTasks.map((task) =>
        task.id === next.id ? next : task,
      );
    }

    function reconcileTaskInput(input, sortOrder, createdBy, reason) {
      const candidate = normalizeTask(input, run.id, sortOrder, createdBy);
      assertCondition(
        !workingTasks.some((task) => task.id === candidate.id),
        "Task identifier already exists in this route.",
        "DUPLICATE_ID",
      );
      if (input.reopen === true) {
        const closed = findRelatedReopenableTask(workingTasks, candidate);
        if (closed) {
          replaceWorkingTask(reopenedTask(closed, candidate, reason));
          return;
        }
      }
      const open = findRelatedOpenTask(workingTasks, candidate);
      if (open) {
        replaceWorkingTask(mergedTask(open, candidate, reason));
        return;
      }
      workingTasks.push(candidate);
    }
  }

  function markTaskActive(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    assertExpectedRevision(run, args);
    const task = store.getTask(args.taskId || run.currentTaskId);
    assertCondition(
      task && task.runId === run.id,
      "Task not found in active route.",
      "TASK_NOT_FOUND",
    );
    assertCondition(
      ["pending", "active"].includes(task.status),
      `Cannot activate task in status ${task.status}. Resume or reopen it through its recorded lifecycle operation.`,
      "INVALID_TRANSITION",
    );
    assertTaskTransition(task.status, "active", { taskId: task.id });
    assertDependenciesTerminal(task, store.getTasks(run.id));
    assertCanSwitchTask(store.getTasks(run.id), task, args);

    const taskUpdates = [];
    for (const other of store.getTasks(run.id)) {
      if (other.status === "active" && other.id !== task.id) {
        taskUpdates.push({
          ...other,
          status: "pending",
          metadata: suspendInternalStepProgress(other.metadata),
        });
      }
    }
    taskUpdates.push({ ...task, status: "active" });
    assertRunTransition(run.status, "active", { runId: run.id });
    assertTaskListTransitions(store.getTasks(run.id), taskUpdates);
    run = commitRunMutation(
      {
        ...run,
        currentTaskId: task.id,
        status: "active",
        routeRevision: (run.routeRevision || 1) + 1,
      },
      taskUpdates,
      "task_started",
      { taskId: task.id, title: task.title, note: args.note || null },
      args,
    );
    const snapshot = snapshotForRun(run, {
      kind: "task_started",
      message: `Working on: ${task.title}`,
      at: nowIso(),
    });
    return args.silent
      ? { run, snapshot }
      : { run, snapshot, markdown: renderDeltaMarkdown(snapshot) };
  }

  function progress(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    assertExpectedRevision(run, args);
    const targetTaskId =
      args.taskId || (hasInternalStepUpdate(args) ? run.currentTaskId : null);
    if (targetTaskId) {
      const task = store.getTask(targetTaskId);
      assertCondition(
        task && task.runId === run.id,
        "Task not found in active route.",
        "TASK_NOT_FOUND",
      );
      assertCondition(
        ["pending", "active"].includes(task.status),
        `Cannot record progress for a task in status ${task.status}. Reconcile the route first.`,
        "INVALID_TRANSITION",
      );
      assertTaskTransition(task.status, "active", { taskId: task.id });
      assertCanSwitchTask(store.getTasks(run.id), task, args);
      const evidence = [
        ...(task.evidence || []),
        evidenceFromArgs(
          args.evidence || {
            kind: "manual_note",
            summary: args.message || "Progress recorded",
          },
        ),
      ];
      const status = task.status === "pending" ? "active" : task.status;
      const metadata = updateInternalStepProgress(task.metadata, args, {
        taskStatus: status,
      });
      assertRunTransition(run.status, "active", { runId: run.id });
      run = commitRunMutation(
        {
          ...run,
          currentTaskId: task.id,
          status: "active",
          routeRevision: (run.routeRevision || 1) + 1,
        },
        [{ ...task, evidence, status, metadata }],
        "progress",
        { message: args.message || null, taskId: args.taskId || null },
        args,
      );
    } else
      recordEvent(
        run.id,
        "progress",
        { message: args.message || null, taskId: args.taskId || null },
        args,
      );
    const snapshot = snapshotForRun(run, {
      kind: "progress",
      message: args.message || "Progress checkpoint recorded.",
      at: nowIso(),
    });
    return { run, snapshot, markdown: renderDeltaMarkdown(snapshot) };
  }

  function completeTask(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    assertExpectedRevision(run, args);
    const taskId = args.taskId || run.currentTaskId;
    const task = store.getTask(taskId);
    assertCondition(
      task && task.runId === run.id,
      "Task not found in active route.",
      "TASK_NOT_FOUND",
    );
    assertCondition(
      args.force !== true,
      "Forced completion is not available through the normal lifecycle API.",
      "PRIVILEGED_OPERATION_REQUIRED",
    );
    assertCondition(
      task.status === "active",
      `Cannot complete a task in status ${task.status}. Activate it through route reconciliation first.`,
      args.expectedRevision === undefined || args.expectedRevision === null
        ? "INVALID_TRANSITION"
        : "REVISION_CONFLICT",
      args.expectedRevision === undefined || args.expectedRevision === null
        ? undefined
        : {
            expectedRevision: Number(args.expectedRevision),
            currentRevision: store.getRun(run.id)?.routeRevision,
            runId: run.id,
          },
    );
    assertTaskTransition(task.status, "done", { taskId: task.id });
    const evidence = args.evidence ? evidenceFromArgs(args.evidence) : null;
    const nextEvidence = evidence
      ? [...(task.evidence || []), evidence]
      : task.evidence || [];
    assertCondition(
      evidence,
      "A task can only be completed after completion evidence is attached.",
      "EVIDENCE_REQUIRED",
    );
    assertInternalStepsComplete(task.metadata);
    const completedTask = {
      ...task,
      status: "done",
      evidence: nextEvidence,
      completedAt: nowIso(),
      metadata: normalizeCompletedInternalSteps(task.metadata),
    };
    const afterCompletion = store
      .getTasks(run.id)
      .map((item) => (item.id === task.id ? completedTask : item));
    const next = chooseCurrentTask(afterCompletion, task.id);
    const taskUpdates = activateTaskList(afterCompletion, next);
    assertRunTransition(run.status, next ? "active" : "ready_to_finalize", {
      runId: run.id,
    });
    assertTaskListTransitions(store.getTasks(run.id), taskUpdates);
    run = commitRunMutation(
      {
        ...run,
        currentTaskId: next?.id || null,
        status: next ? "active" : "ready_to_finalize",
        routeRevision: (run.routeRevision || 1) + 1,
      },
      taskUpdates,
      "task_completed",
      { taskId: task.id, title: task.title, evidence },
      args,
    );
    const snapshot = snapshotForRun(run, {
      kind: "task_completed",
      taskId: task.id,
      message: `Completed: ${task.title}`,
      at: nowIso(),
    });
    return { run, snapshot, markdown: renderDeltaMarkdown(snapshot) };
  }

  function blockTask(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    assertExpectedRevision(run, args);
    const task = store.getTask(args.taskId || run.currentTaskId);
    assertCondition(
      task && task.runId === run.id,
      "Task not found in active route.",
      "TASK_NOT_FOUND",
    );
    assertCondition(
      task.status === "active",
      `Cannot block a task in status ${task.status}. Activate it through route reconciliation first.`,
      "INVALID_TRANSITION",
    );
    assertTaskTransition(task.status, "blocked", { taskId: task.id });
    const evidence = evidenceFromArgs(
      args.evidence || {
        kind: "blocker",
        summary: args.reason || "Task blocked",
      },
    );
    assertRunTransition(run.status, "blocked", { runId: run.id });
    assertTaskListTransitions(store.getTasks(run.id), [
      { ...task, status: "blocked" },
    ]);
    run = commitRunMutation(
      {
        ...run,
        currentTaskId: task.id,
        status: "blocked",
        routeRevision: (run.routeRevision || 1) + 1,
      },
      [
        {
          ...task,
          status: "blocked",
          evidence: [...(task.evidence || []), evidence],
          metadata: {
            ...(task.metadata || {}),
            blockerRequiresUser: Boolean(args.requiresUser),
            blockerReason: args.reason || null,
          },
        },
      ],
      "task_blocked",
      {
        taskId: task.id,
        reason: args.reason || null,
        requiresUser: Boolean(args.requiresUser),
      },
      args,
    );
    const snapshot = snapshotForRun(run, {
      kind: "task_blocked",
      message: `Blocked: ${task.title}${args.reason ? ` — ${args.reason}` : ""}`,
      at: nowIso(),
    });
    return {
      run,
      snapshot,
      markdown: renderDeltaMarkdown(snapshot, { title: "OTM Gate" }),
    };
  }

  function dropTask(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    assertExpectedRevision(run, args);
    const task = store.getTask(args.taskId);
    assertCondition(
      task && task.runId === run.id,
      "Task not found in active route.",
      "TASK_NOT_FOUND",
    );
    assertCondition(
      !["done", "dropped", "superseded"].includes(task.status),
      "Completed or terminal tasks must be explicitly reopened before they can be dropped or superseded.",
      "INVALID_TRANSITION",
    );
    assertTaskTransition(
      task.status,
      args.supersede ? "superseded" : "dropped",
      { taskId: task.id, reason: args.reason || null },
    );
    const terminalTask = {
      ...task,
      status: args.supersede ? "superseded" : "dropped",
      metadata: terminalizeInternalSteps({
        ...(task.metadata || {}),
        reason: args.reason || null,
      }),
    };
    const afterTerminal = store
      .getTasks(run.id)
      .map((item) => (item.id === task.id ? terminalTask : item));
    const next = chooseCurrentTask(afterTerminal, task.id);
    const taskUpdates = activateTaskList(afterTerminal, next);
    assertRunTransition(run.status, next ? "active" : "ready_to_finalize", {
      runId: run.id,
    });
    assertTaskListTransitions(store.getTasks(run.id), taskUpdates);
    run = commitRunMutation(
      {
        ...run,
        currentTaskId: next?.id || null,
        status: next ? "active" : "ready_to_finalize",
        routeRevision: (run.routeRevision || 1) + 1,
      },
      taskUpdates,
      args.supersede ? "task_superseded" : "task_dropped",
      { taskId: task.id, reason: args.reason || null },
      args,
    );
    const snapshot = snapshotForRun(run, {
      kind: args.supersede ? "task_superseded" : "task_dropped",
      message: `${args.supersede ? "Superseded" : "Dropped"}: ${task.title}`,
      at: nowIso(),
    });
    return { run, snapshot, markdown: renderDeltaMarkdown(snapshot) };
  }

  function auditStop(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = null;
    try {
      run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    } catch (error) {
      if (error?.code !== "NO_ACTIVE_RUN") throw error;
    }
    if (!run) {
      const snapshot = clearedSnapshot(
        workspaceRoot,
        { message: "No active route. Stop is allowed." },
        null,
        sessionId,
      );
      return {
        stopAllowed: true,
        run: null,
        snapshot,
        markdown: renderSnapshotMarkdown(snapshot),
      };
    }
    const tasks = store.getTasks(run.id);
    const remainingRequired = tasks.filter(
      (task) =>
        task.required &&
        !["done", "dropped", "superseded"].includes(task.status),
    );
    const stopAllowed = remainingRequired.length === 0;
    const snapshot = snapshotForRun(run, {
      kind: "stop_audit",
      message: stopAllowed
        ? "Audit passed. All required route segments are complete."
        : `Audit blocked. ${remainingRequired.length} required route segment${remainingRequired.length === 1 ? "" : "s"} remain.`,
      at: nowIso(),
    });
    return {
      stopAllowed,
      run,
      remainingRequired: remainingRequired.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        required: task.required,
      })),
      snapshot,
      markdown: renderSnapshotMarkdown(snapshot),
    };
  }

  function finalizeTurn(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    assertExpectedRevision(run, args);
    const requestedSummaryId =
      args.summaryId || deterministicSummaryId(run.id, args);
    const existingSummary = requestedSummaryId
      ? store
          .listSummaries(workspaceRoot, 10_000)
          .find(
            (item) => item.runId === run.id && item.id === requestedSummaryId,
          )
      : null;
    if (existingSummary && run.finalizedAt) {
      publishSummaryFiles(workspaceRoot, run.id, existingSummary);
      const snapshot = snapshotForRun(run, {
        kind: "turn_finalized",
        message: "Existing turn summary republished after retry.",
        at: nowIso(),
      });
      return {
        run,
        summary: existingSummary,
        summaryJson: existingSummary.summaryJson,
        summaryMd: existingSummary.summaryMd,
        snapshot,
        markdown: existingSummary.summaryMd,
        idempotent: true,
      };
    }
    const audit = auditStop({ workspaceRoot, runId: run.id, sessionId });
    if (!audit.stopAllowed && args.allowIncomplete !== true) {
      throw new OtmError(
        "Cannot finalize while required route segments remain open.",
        { code: "STOP_AUDIT_FAILED", details: audit.remainingRequired },
      );
    }
    if (!audit.stopAllowed) {
      assertCondition(
        typeof args.reason === "string" && args.reason.trim(),
        "Incomplete finalization requires an explicit reason.",
        "INCOMPLETE_FINALIZATION_REASON_REQUIRED",
      );
    }
    const tasks = store.getTasks(run.id);
    const summaryJson = buildSummaryJson({
      run,
      tasks,
      outcome: args.outcome || (audit.stopAllowed ? "completed" : "incomplete"),
      nextSteps: args.nextSteps || [],
    });
    const summaryMd = renderSummaryMarkdown(summaryJson);
    const summaryId = requestedSummaryId || newId("summary");
    const createdAt = nowIso();
    const turnId = args.turnId || run.turnId || "manual";
    const summary = {
      id: summaryId,
      runId: run.id,
      workspaceRoot,
      turnId,
      summaryMd,
      summaryJson,
      currentCleared: false,
      createdAt,
    };
    // Commit the complete recoverable summary record first. If publication to
    // the workspace later fails, doctor/repair can reconstruct both files
    // from durable summary metadata instead of trying to infer an orphan.
    const finalStatus = audit.stopAllowed ? "completed" : "blocked";
    assertRunTransition(run.status, finalStatus, { runId: run.id });
    run = commitRunMutation(
      {
        ...run,
        status: finalStatus,
        finalizedAt: createdAt,
        routeRevision: (run.routeRevision || 1) + 1,
        metadata: audit.stopAllowed
          ? run.metadata
          : {
              ...(run.metadata || {}),
              incompleteFinalizationReason: args.reason.trim(),
            },
      },
      [],
      "turn_finalized",
      {
        summaryId,
        complete: audit.stopAllowed,
        reason: audit.stopAllowed ? null : args.reason.trim(),
      },
      args,
      [summary],
    );
    publishSummaryFiles(workspaceRoot, run.id, summary);
    upsertMemory({
      id: `mem_${shortHash(`turn-summary:${run.id}:${summaryId}`)}`,
      workspaceRoot,
      kind: "turn_summary",
      title: `Turn summary: ${run.goal}`,
      body: summaryMd,
      tags: ["turn-summary", "checkpoint"],
      source: { runId: run.id, summaryId, turnId },
    });
    const snapshot = snapshotForRun(run, {
      kind: "turn_finalized",
      message: "Turn summary written. Active route can now be cleared.",
      at: createdAt,
    });
    if (args.clear === true || args.clearCurrent === true) {
      const cleared = clearCurrent({
        workspaceRoot,
        runId: run.id,
        sessionId,
        deleteFiles: Boolean(args.deleteFiles),
      });
      return {
        run,
        summary,
        summaryJson,
        summaryMd,
        snapshot: cleared.snapshot || snapshot,
        cleared,
        markdown: `${summaryMd}
${cleared.markdown || ""}`,
      };
    }
    return {
      run,
      summary,
      summaryJson,
      summaryMd,
      snapshot,
      markdown: summaryMd,
    };
  }

  function publishSummaryFiles(workspaceRoot, runId, summary) {
    ensureDir(summariesDir(workspaceRoot));
    // External turn/summary identifiers remain record metadata only; filenames
    // are generated from a fixed namespace and hash to prevent path injection.
    const base = path.join(
      summariesDir(workspaceRoot),
      safeGeneratedFileId("summary", `${runId}:${summary.id}`),
    );
    const tempDir = workspaceTempDir(workspaceRoot);
    return {
      json: atomicWriteJson(`${base}.json`, summary.summaryJson, { tempDir }),
      markdown: atomicWriteText(`${base}.md`, summary.summaryMd, { tempDir }),
    };
  }

  function repairSummaries(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const summaries = store.listSummaries(workspaceRoot, 10_000);
    if (args.dryRun === true)
      return {
        workspaceRoot,
        dryRun: true,
        matched: summaries.length,
        repaired: 0,
      };
    const repaired = summaries.reduce((count, summary) => {
      const result = publishSummaryFiles(workspaceRoot, summary.runId, summary);
      return count + (result.json || result.markdown ? 1 : 0);
    }, 0);
    return {
      workspaceRoot,
      dryRun: false,
      matched: summaries.length,
      repaired,
    };
  }

  function clearCurrent(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = null;
    try {
      run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    } catch (error) {
      if (error?.code !== "NO_ACTIVE_RUN") throw error;
    }
    if (!run && !args.runId) {
      const current = readOtmJsonArtifact(
        currentJsonPath(workspaceRoot, sessionId),
      );
      if (current?.runId) {
        const candidate = store.getRun(current.runId);
        if (
          candidate &&
          sameWorkspace(candidate.workspaceRoot, workspaceRoot) &&
          (!sessionId ||
            !candidate.sessionId ||
            candidate.sessionId === sessionId)
        )
          run = candidate;
      }
    }
    if (run) {
      assertExpectedRevision(run, args);
      const finalized =
        Boolean(run.finalizedAt) &&
        ["completed", "blocked"].includes(run.status);
      const explicitAbandon =
        args.abandon === true &&
        typeof args.reason === "string" &&
        args.reason.trim();
      assertCondition(
        finalized || explicitAbandon,
        "Current state can only be cleared after finalization. Use the explicit abandon operation with a reason for unfinished work.",
        "CLEAR_REQUIRES_FINALIZATION",
      );
      const summaries = store
        .listSummaries(workspaceRoot, 100)
        .filter((item) => item.runId === run.id && !item.currentCleared)
        .map((summary) => ({ ...summary, currentCleared: true }));
      const nextStatus = explicitAbandon
        ? "abandoned"
        : args.status || "cleared";
      assertRunTransition(run.status, nextStatus, { runId: run.id });
      run = commitRunMutation(
        {
          ...run,
          status: nextStatus,
          finalizedAt: run.finalizedAt || nowIso(),
          metadata: explicitAbandon
            ? { ...(run.metadata || {}), abandonedReason: args.reason.trim() }
            : run.metadata,
          routeRevision: (run.routeRevision || 1) + 1,
        },
        [],
        "current_cleared",
        { mode: args.deleteFiles ? "delete" : "tombstone" },
        args,
        summaries,
      );
    }
    const hasScopedActiveRuns = store
      .listActiveRuns(workspaceRoot)
      .some((item) => item.sessionId);
    const cleanupOptions = sessionId
      ? { sessionId, minAgeMs: 0, scratchMaxAgeMs: 0 }
      : { minAgeMs: 0, scratchMaxAgeMs: hasScopedActiveRuns ? -1 : 0 };
    if (args.deleteFiles) {
      removeFileIfExists(currentJsonPath(workspaceRoot, sessionId));
      removeFileIfExists(currentMarkdownPath(workspaceRoot, sessionId));
      if (sessionId || hasScopedActiveRuns)
        writeWorkspaceCurrentIndex(workspaceRoot);
      cleanupWorkspaceStateTempFiles(workspaceRoot, cleanupOptions);
      const maintenance = runPostClearMaintenance(workspaceRoot);
      const markdown = appendMaintenanceWarnings(
        "## ✅ Overtli Task Manager\n\nActive route cleared.\n",
        maintenance.warnings,
      );
      return { cleared: true, deleted: true, maintenance, markdown };
    }
    const tombstone = clearedSnapshot(
      workspaceRoot,
      { message: "Active route cleared after summary." },
      run?.id || null,
      sessionId || run?.sessionId || null,
    );
    if (!sessionId && hasScopedActiveRuns)
      writeWorkspaceCurrentIndex(workspaceRoot);
    else writeCurrentFiles(workspaceRoot, tombstone);
    cleanupWorkspaceStateTempFiles(workspaceRoot, cleanupOptions);
    const maintenance = runPostClearMaintenance(workspaceRoot);
    return {
      cleared: true,
      deleted: false,
      snapshot: tombstone,
      maintenance,
      markdown: appendMaintenanceWarnings(
        renderSnapshotMarkdown(tombstone),
        maintenance.warnings,
      ),
    };
  }

  function cleanupWorkspace(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    assertCondition(
      args.allSessions !== true || args.confirm === true,
      "Cleaning scratch evidence for all sessions requires explicit confirmation.",
      "CLEANUP_CONFIRMATION_REQUIRED",
    );
    const activeRuns = store.listActiveRuns(workspaceRoot);
    const activeSessionIds = activeRuns
      .map((run) => run.sessionId)
      .filter(Boolean);
    const preserveAnyActiveScratch =
      args.allSessions !== true && activeRuns.length > 0;
    const removed = cleanupWorkspaceStateTempFiles(workspaceRoot, {
      minAgeMs: args.minAgeMs ?? 0,
      scratchMaxAgeMs: preserveAnyActiveScratch ? -1 : args.scratchMaxAgeMs,
      excludeSessionIds: args.allSessions === true ? [] : activeSessionIds,
      dryRun: args.dryRun === true,
    });
    const lines = [
      `## ${args.dryRun ? "🧪" : "✅"} OTM cleanup`,
      "",
      `Workspace: \`${workspaceRoot}\``,
      `${args.dryRun ? "Matched" : "Removed"} artifact(s): ${removed.length}`,
      `Active-session scratch skipped: ${args.allSessions === true ? 0 : activeRuns.length}`,
    ];
    return {
      workspaceRoot,
      dryRun: args.dryRun === true,
      removed,
      skippedActiveSessions:
        args.allSessions === true
          ? []
          : activeRuns.map((run) => run.sessionId || "unscoped"),
      markdown: `${lines.join("\n")}\n`,
    };
  }

  function abandonRun(args = {}) {
    assertCondition(
      typeof args.reason === "string" && args.reason.trim(),
      "Abandon requires an explicit reason.",
      "ABANDON_REASON_REQUIRED",
    );
    return clearCurrent({ ...args, abandon: true, status: "abandoned" });
  }

  function resumeRun(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    assertExpectedRevision(run, args);
    assertCondition(
      ["blocked", "paused"].includes(run.status) && !run.finalizedAt,
      "Only an unfinished blocked or paused route can be resumed.",
      "INVALID_TRANSITION",
    );
    const tasks = store.getTasks(run.id);
    const target =
      tasks.find((task) => task.id === (args.taskId || run.currentTaskId)) ||
      tasks.find((task) => task.status === "blocked") ||
      tasks.find((task) => task.status === "pending");
    assertCondition(
      target,
      "No resumable task exists for this route.",
      "INVALID_TRANSITION",
    );
    assertCondition(
      !["done", "dropped", "superseded"].includes(target.status),
      "Terminal tasks cannot be resumed without an explicit reconcile reopen.",
      "INVALID_TRANSITION",
    );
    assertDependenciesTerminal(target, tasks);
    assertTaskTransition(target.status, "active", { taskId: target.id });
    assertRunTransition(run.status, "active", { runId: run.id });
    const updatedTasks = tasks.map((task) => {
      if (task.id === target.id)
        return {
          ...task,
          status: "active",
          completedAt: null,
          metadata: ensureInternalStepProgress(
            {
              ...(task.metadata || {}),
              resumedAt: nowIso(),
              resumedReason: args.reason || null,
            },
            "active",
          ),
        };
      if (task.status === "active")
        return {
          ...task,
          status: "pending",
          metadata: suspendInternalStepProgress(task.metadata),
        };
      return task;
    });
    assertTaskListTransitions(tasks, updatedTasks);
    run = commitRunMutation(
      {
        ...run,
        status: "active",
        currentTaskId: target.id,
        routeRevision: (run.routeRevision || 1) + 1,
      },
      updatedTasks,
      "run_resumed",
      { taskId: target.id, reason: args.reason || null },
      args,
    );
    const snapshot = snapshotForRun(run, {
      kind: "run_resumed",
      taskId: target.id,
      message: `Resumed: ${target.title}`,
      at: nowIso(),
    });
    return { run, snapshot, markdown: renderDeltaMarkdown(snapshot) };
  }

  function archiveRun(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    assertExpectedRevision(run, args);
    if (run.status === "archived")
      return { run, archived: false, idempotent: true };
    assertCondition(
      ["completed", "cleared", "abandoned"].includes(run.status) &&
        Boolean(run.finalizedAt),
      "Only finalized, cleared, or abandoned routes can be archived.",
      "INVALID_TRANSITION",
    );
    assertRunTransition(run.status, "archived", { runId: run.id });
    run = commitRunMutation(
      {
        ...run,
        status: "archived",
        routeRevision: (run.routeRevision || 1) + 1,
        metadata: {
          ...(run.metadata || {}),
          archivedAt: nowIso(),
          archiveReason: args.reason || null,
        },
      },
      [],
      "run_archived",
      { reason: args.reason || null },
      args,
    );
    return { run, archived: true, idempotent: false };
  }

  function pruneHistory(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    assertCondition(
      typeof store.pruneHistory === "function",
      "Current OTM store does not support history pruning.",
      "PRUNE_UNSUPPORTED",
    );
    const retentionDays = normalizeRetentionDays(args.retentionDays);
    const olderThan =
      args.olderThan || retentionCutoffIso(retentionDays, args.now);
    const result = store.pruneHistory({
      workspaceRoot,
      retentionDays,
      olderThan,
      now: args.now || nowIso(),
      dryRun: args.dryRun === true,
    });
    return { ...result, markdown: renderPruneHistoryMarkdown(result) };
  }

  function runPostClearMaintenance(workspaceRoot) {
    const warnings = [];
    try {
      if (typeof store.pruneHistory !== "function")
        return { pruned: null, warnings };
      return { pruned: pruneHistory({ workspaceRoot }), warnings };
    } catch (error) {
      // Clearing a finalized route is already durable. Do not roll it back for
      // optional retention maintenance, but never hide a failure that needs
      // explicit operator follow-up.
      warnings.push(
        `Automatic history pruning was not completed: ${redactSensitiveText(error?.message || String(error))}`,
      );
      return { pruned: null, warnings };
    }
  }

  function snapshot(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const sessionId = resolveSessionId(args, env);
    let run = null;
    try {
      run = getRunOrActive({ runId: args.runId, workspaceRoot, sessionId });
    } catch (error) {
      if (error?.code !== "NO_ACTIVE_RUN") throw error;
    }
    if (!run) {
      const empty = clearedSnapshot(
        workspaceRoot,
        { message: "No active route." },
        null,
        sessionId,
      );
      if (args.write !== false) {
        const hasScopedActiveRuns = store
          .listActiveRuns(workspaceRoot)
          .some((item) => item.sessionId);
        if (!sessionId && hasScopedActiveRuns)
          writeWorkspaceCurrentIndex(workspaceRoot);
        else writeCurrentFiles(workspaceRoot, empty);
      }
      return {
        run: null,
        snapshot: empty,
        markdown: renderSnapshotMarkdown(empty),
      };
    }
    const snap = snapshotForRun(run, args.lastUpdate || null, {
      write: args.write !== false,
    });
    return { run, snapshot: snap, markdown: renderSnapshotMarkdown(snap) };
  }

  function upsertMemory(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const now = nowIso();
    const id =
      args.id ||
      `mem_${shortHash(`${workspaceRoot}:${args.kind}:${args.title}`)}`;
    const entry = {
      id,
      workspaceRoot,
      kind: args.kind || "note",
      title: String(args.title || "Project memory").trim(),
      body: String(args.body || "").trim(),
      tags: normalizeMemoryTags(args.tags),
      source: args.source || {},
      scoreHint: Number(args.scoreHint || 0),
      createdAt: args.createdAt || now,
      updatedAt: now,
      expiresAt: args.expiresAt || null,
    };
    assertCondition(entry.body, "Memory body is required.", "INVALID_MEMORY");
    assertCondition(
      entry.title.length <= 500 && entry.body.length <= 16_000,
      "Memory entry exceeds the size limit.",
      "INPUT_TOO_LARGE",
    );
    assertCondition(
      Number.isFinite(entry.scoreHint) &&
        entry.scoreHint >= 0 &&
        entry.scoreHint <= 1_000,
      "Memory scoreHint must be between 0 and 1000.",
      "INVALID_MEMORY",
    );
    store.upsertCache(entry);
    return { entry };
  }

  function searchMemory(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const query = String(args.query || "").trim();
    const limit = clampLimit(args.limit, 10, 100);
    const entries = store
      .listCache(workspaceRoot, 500)
      .filter(
        (entry) => !entry.expiresAt || String(entry.expiresAt) > nowIso(),
      );
    const scored = entries
      .map((entry) => ({ entry, ...scoreEntry(entry, query) }))
      .filter((item) => !query || item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return {
      entries: scored.map(({ entry, score, matchReasons }) => ({
        ...entry,
        score,
        matchReasons,
      })),
    };
  }

  function deleteMemory(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const selectors = ["id", "kind", "tag"].filter(
      (key) => typeof args[key] === "string" && args[key].trim(),
    );
    const all = args.all === true;
    assertCondition(
      selectors.length > 0 || all,
      "At least one memory selector is required.",
      "MEMORY_SELECTOR_REQUIRED",
    );
    assertCondition(
      !all || args.confirm === true,
      "Workspace-wide memory deletion requires all:true and explicit confirmation.",
      "MEMORY_DELETE_CONFIRMATION_REQUIRED",
    );
    const filter = all ? { workspaceRoot } : { ...args, workspaceRoot };
    const matched = store
      .listCache(workspaceRoot, 10_000)
      .filter((entry) => memoryMatches(entry, filter));
    if (args.dryRun === true)
      return {
        deleted: 0,
        dryRun: true,
        matched: matched.length,
        entries: matched.map((entry) => ({
          id: entry.id,
          title: entry.title,
          kind: entry.kind,
        })),
      };
    return { deleted: store.deleteCache(filter), matched: matched.length };
  }

  function listMemory(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const limit = clampLimit(args.limit, 50, 500);
    const entries = store
      .listCache(workspaceRoot, limit)
      .filter(
        (entry) => !entry.expiresAt || String(entry.expiresAt) > nowIso(),
      );
    return { entries };
  }

  function inspectMemory(args = {}) {
    assertCondition(
      typeof args.id === "string" && args.id.trim(),
      "Memory id is required.",
      "MEMORY_SELECTOR_REQUIRED",
    );
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const entry = store
      .listCache(workspaceRoot, 10_000)
      .find((item) => item.id === args.id);
    assertCondition(entry, "Memory entry not found.", "MEMORY_NOT_FOUND");
    return { entry };
  }

  function purgeExpiredMemory(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const now = args.now || nowIso();
    const matched = store
      .listCache(workspaceRoot, 10_000)
      .filter((entry) => entry.expiresAt && String(entry.expiresAt) <= now);
    if (args.dryRun === true)
      return { dryRun: true, deleted: 0, matched: matched.length };
    return {
      dryRun: false,
      deleted: store.deleteCache({ workspaceRoot, expired: true, now }),
      matched: matched.length,
    };
  }

  function listRuns(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    return { runs: store.listRuns(workspaceRoot, Number(args.limit || 20)) };
  }

  function exportWorkspace(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    assertCondition(
      typeof store.exportWorkspace === "function",
      "Current OTM store does not support export.",
      "EXPORT_UNSUPPORTED",
    );
    const payload = store.exportWorkspace(workspaceRoot);
    return {
      schemaVersion: "otm.export.v1",
      exportedAt: nowIso(),
      workspaceRoot,
      storageKind: store.kind,
      ...payload,
    };
  }

  function importHistorical(args = {}) {
    const workspaceRoot = resolveWorkspace(
      args.workspaceRoot || findWorkspaceRoot(args.cwd),
    );
    const document = validateHistoricalImport(args.document, workspaceRoot);
    assertCondition(
      typeof store.importWorkspace === "function",
      "Current OTM store does not support import.",
      "IMPORT_UNSUPPORTED",
    );
    if (args.dryRun === true)
      return {
        workspaceRoot,
        dryRun: true,
        imported: importDocumentCounts(document),
      };
    const imported = store.importWorkspace(document);
    return { workspaceRoot, dryRun: false, imported };
  }

  return {
    store,
    close: () => store.close?.(),
    start,
    reconcile,
    markTaskActive,
    progress,
    completeTask,
    blockTask,
    dropTask,
    auditStop,
    finalizeTurn,
    clearCurrent,
    abandonRun,
    resumeRun,
    archiveRun,
    repairSummaries,
    cleanupWorkspace,
    pruneHistory,
    snapshot,
    upsertMemory,
    searchMemory,
    deleteMemory,
    listMemory,
    inspectMemory,
    purgeExpiredMemory,
    listRuns,
    exportWorkspace,
    importHistorical,
    recordEvent,
  };
}

function normalizeBoundedStrings(value, name, maxItems, maxLength) {
  assertCondition(
    Array.isArray(value),
    `${name} must be an array.`,
    "INVALID_INPUT",
  );
  assertCondition(
    value.length <= maxItems,
    `${name} exceed the maximum item count.`,
    "INPUT_TOO_LARGE",
  );
  return value.map((item) =>
    assertNonEmptyString(String(item), name, maxLength),
  );
}

function normalizeBoundedInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null) return fallback;
  const numeric = Number(value);
  assertCondition(
    Number.isInteger(numeric) && numeric >= min && numeric <= max,
    `${name} must be an integer between ${min} and ${max}.`,
    "INVALID_INPUT",
  );
  return numeric;
}

function normalizeTaskEvidence(value) {
  assertCondition(
    Array.isArray(value),
    "Task evidence must be an array.",
    "INVALID_INPUT",
  );
  assertCondition(
    value.length <= LIMITS.evidence,
    "Task evidence exceeds the maximum item count.",
    "INPUT_TOO_LARGE",
  );
  return value.map((item) => evidenceFromArgs(item));
}

function evidenceFromArgs(input = {}) {
  assertCondition(
    input && typeof input === "object" && !Array.isArray(input),
    "Evidence must be an object.",
    "INVALID_INPUT",
  );
  const summary = assertNonEmptyString(
    String(input.summary || input.message || "Evidence captured"),
    "evidence summary",
    LIMITS.text,
  );
  const kind = assertNonEmptyString(
    String(input.kind || "manual_note"),
    "evidence kind",
    80,
  );
  const files =
    input.files === undefined ? undefined : normalizeEvidenceFiles(input.files);
  const command =
    input.command === undefined || input.command === null
      ? undefined
      : redactSensitiveText(
          assertNonEmptyString(
            String(input.command),
            "evidence command",
            LIMITS.text,
          ),
        );
  const exitCode =
    input.exitCode === undefined || input.exitCode === null
      ? undefined
      : normalizeExitCode(input.exitCode);
  if (input.notes !== undefined) assertAcyclicContext(input.notes, 64 * 1024);
  return omitEmpty({
    kind,
    summary: redactSensitiveText(summary),
    files,
    command,
    exitCode,
    notes: input.notes ? redactEvidenceValue(input.notes) : undefined,
    at: nowIso(),
  });
}

function normalizeEvidenceFiles(value) {
  assertCondition(
    Array.isArray(value),
    "Evidence files must be an array.",
    "INVALID_INPUT",
  );
  assertCondition(
    value.length <= 128,
    "Evidence files exceed the maximum item count.",
    "INPUT_TOO_LARGE",
  );
  return value.map((item) =>
    assertNonEmptyString(String(item), "evidence file", 4_000),
  );
}

function normalizeExitCode(value) {
  const numeric = Number(value);
  assertCondition(
    Number.isInteger(numeric) && numeric >= -255 && numeric <= 255,
    "Evidence exitCode must be an integer between -255 and 255.",
    "INVALID_INPUT",
  );
  return numeric;
}

function deterministicSummaryId(runId, args = {}) {
  const operation = args.operationId || args.idempotencyKey || args.turnId;
  return operation ? `summary_${shortHash(`${runId}:${operation}`)}` : null;
}

function redactEvidenceValue(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactEvidenceValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) =>
        /authorization|token|secret|password|private.?key/i.test(key)
          ? [key, "[REDACTED]"]
          : [key, redactEvidenceValue(item)],
      ),
    );
  }
  return value;
}

function buildSummaryJson({ run, tasks, outcome, nextSteps }) {
  const completed = tasks
    .filter((task) => task.status === "done")
    .map((task) => task.title);
  const blocked = tasks
    .filter((task) => task.status === "blocked")
    .map((task) => task.title);
  const dropped = tasks
    .filter((task) => ["dropped", "superseded"].includes(task.status))
    .map((task) => task.title);
  const evidence = tasks.flatMap((task) =>
    (task.evidence || []).map(
      (item) => `${task.title}: ${item.summary || item.kind}`,
    ),
  );
  return omitEmpty({
    schemaVersion: "otm.summary.v1",
    manager: MANAGER_NAME,
    runId: run.id,
    turnId: run.turnId || undefined,
    workspaceRoot: run.workspaceRoot,
    goal: run.goal,
    outcome,
    completed,
    blocked,
    dropped,
    evidence,
    nextSteps,
    routeRevision: run.routeRevision || 1,
    createdAt: nowIso(),
  });
}

function normalizeRetentionDays(value) {
  if (value === undefined || value === null || value === "")
    return DEFAULT_HISTORY_RETENTION_DAYS;
  const days = Number(value);
  assertCondition(
    Number.isFinite(days) && days >= 0,
    "retentionDays must be a non-negative number.",
    "INVALID_RETENTION",
  );
  return days;
}

function retentionCutoffIso(retentionDays, now = null) {
  const base = now ? new Date(now) : new Date();
  assertCondition(
    !Number.isNaN(base.getTime()),
    "now must be a valid date/time.",
    "INVALID_RETENTION",
  );
  return new Date(
    base.getTime() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function renderPruneHistoryMarkdown(result = {}) {
  const deleted = result.deleted || {};
  const total = Object.values(deleted).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );
  const lines = [
    `## ${result.dryRun ? "🧪" : "✅"} OTM history cleanup`,
    "",
    `Workspace: \`${result.workspaceRoot || "all workspaces"}\``,
    `Retention: ${result.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS} day(s)`,
    `Cutoff: \`${result.olderThan}\``,
    `Mode: ${result.dryRun ? "dry run" : "deleted"}`,
    "",
    "| Table | Rows |",
    "|---|---:|",
    `| runs | ${deleted.runs || 0} |`,
    `| tasks | ${deleted.tasks || 0} |`,
    `| events | ${deleted.events || 0} |`,
    `| summaries | ${deleted.summaries || 0} |`,
    `| cache_entries | ${deleted.cacheEntries || 0} |`,
    `| total | ${total} |`,
  ];
  return `${lines.join("\n")}\n`;
}

function clearedSnapshot(
  workspaceRoot,
  lastUpdate = null,
  lastRunId = null,
  sessionId = null,
) {
  return omitEmpty({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    manager: MANAGER_NAME,
    status: "cleared",
    lastRunId: lastRunId || undefined,
    sessionId: sessionId || undefined,
    workspaceRoot,
    goal: "No active route",
    routeRevision: 0,
    phase: "idle",
    stopAllowed: true,
    stopReason: "No active route.",
    progress: {
      requiredDone: 0,
      requiredTotal: 0,
      optionalDone: 0,
      optionalTotal: 0,
      percentRequired: 100,
    },
    checklist: [],
    tasks: [],
    lastUpdate: lastUpdate || undefined,
    storage: { kind: "unknown" },
    paths: {
      currentJson: path
        .relative(workspaceRoot, currentJsonPath(workspaceRoot, sessionId))
        .split(path.sep)
        .join("/"),
      currentMarkdown: path
        .relative(workspaceRoot, currentMarkdownPath(workspaceRoot, sessionId))
        .split(path.sep)
        .join("/"),
    },
    updatedAt: nowIso(),
  });
}

function appendMaintenanceWarnings(markdown, warnings = []) {
  if (!warnings.length) return markdown;
  return `${markdown.trimEnd()}\n\n### Maintenance warning\n\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n`;
}

function omitEmpty(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null,
    ),
  );
}

function sameWorkspace(left, right) {
  return workspaceIdentity(left) === workspaceIdentity(right);
}

function clampLimit(value, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  assertCondition(
    Number.isInteger(numeric) && numeric >= 1 && numeric <= maximum,
    `Limit must be an integer between 1 and ${maximum}.`,
    "INVALID_LIMIT",
  );
  return numeric;
}

function normalizeMemoryTags(value) {
  if (value == null) return [];
  assertCondition(
    Array.isArray(value) && value.length <= 32,
    "Memory tags must be an array with at most 32 values.",
    "INVALID_MEMORY",
  );
  const tags = value
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean);
  assertCondition(
    tags.every((tag) => tag.length <= 80),
    "Memory tag exceeds the maximum length.",
    "INPUT_TOO_LARGE",
  );
  return [...new Set(tags)];
}

function memoryMatches(entry, filter) {
  if (filter.id && entry.id !== filter.id) return false;
  if (filter.kind && entry.kind !== filter.kind) return false;
  if (
    filter.tag &&
    !(entry.tags || [])
      .map((tag) => String(tag).toLowerCase())
      .includes(String(filter.tag).trim().toLowerCase())
  )
    return false;
  return true;
}

function assertInitialTaskStatus(status) {
  assertKnownEnum(status, TASK_STATUSES, "task status");
  assertCondition(
    status === "pending" || status === "active",
    "Initial route tasks must be pending or active.",
    "INVALID_INITIAL_TASK_STATUS",
  );
  return status;
}

function normalizeTaskMetadata(input, acceptanceCriteria) {
  const metadata = { ...(input.metadata || {}) };
  const internalSteps = normalizeInternalSteps(input, acceptanceCriteria);
  if (internalSteps.length) metadata.internalSteps = internalSteps;
  return metadata;
}

function normalizeActiveTasks(tasks) {
  const active =
    tasks.find((task) => task.status === "active") || tasks[0] || null;
  for (const task of tasks) {
    if (task.id === active?.id && task.status === "pending")
      task.status = "active";
    else if (task.id !== active?.id && task.status === "active")
      task.status = "pending";
    task.metadata = ensureInternalStepProgress(task.metadata, task.status);
  }
}

function normalizeInternalSteps(input, acceptanceCriteria = []) {
  const supplied = Array.isArray(input.internalSteps)
    ? input.internalSteps
    : input.metadata?.internalSteps;
  if (Array.isArray(supplied))
    assertUniqueIds(
      supplied.filter((step) => step && typeof step === "object" && step.id),
      "internal step",
    );
  const explicit = Array.isArray(supplied)
    ? normalizeInternalStepList(supplied)
    : [];
  if (explicit.length) return explicit;

  const criteriaSteps = unionStrings(acceptanceCriteria).filter(
    (item) => item !== "Complete this route segment with concrete evidence.",
  );
  if (criteriaSteps.length) return normalizeInternalStepList(criteriaSteps);

  const title = String(input.title || "route segment").trim();
  return normalizeInternalStepList(defaultInternalStepsForTask(input, title));
}

function defaultInternalStepsForTask(input, title) {
  const category = inferTaskCategory(input, title);
  if (category === "summary") {
    return [
      `Reconcile route evidence for ${title}`,
      `Write or present the final summary for ${title}`,
      `Verify stop-audit readiness for ${title}`,
      `Record finalization evidence for ${title}`,
    ];
  }
  if (category === "validation") {
    return [
      `Identify the relevant checks for ${title}`,
      `Run targeted checks for ${title}`,
      `Inspect failures or regressions for ${title}`,
      `Record validation evidence for ${title}`,
    ];
  }
  if (category === "install") {
    return [
      `Inspect target install state for ${title}`,
      `Run the install or configuration command for ${title}`,
      `Verify install or doctor output for ${title}`,
      `Record install evidence for ${title}`,
    ];
  }
  if (category === "docs") {
    return [
      `Inspect source-of-truth material for ${title}`,
      `Draft or update documentation for ${title}`,
      `Verify commands, paths, and status claims for ${title}`,
      `Record documentation evidence for ${title}`,
    ];
  }
  return [
    `Inspect affected code and existing patterns for ${title}`,
    `Implement the complete requested change for ${title}`,
    `Update related tests, docs, or configuration for ${title}`,
    `Run relevant checks and record evidence for ${title}`,
  ];
}

function inferTaskCategory(input, title) {
  const text = [
    input.category,
    input.kind,
    input.type,
    input.metadata?.category,
    input.description,
    title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    /\b(finali[sz]e|final summary|summari[sz]e|summary|clear active|checkpoint|closeout)\b/.test(
      text,
    )
  )
    return "summary";
  if (
    /\b(validate|validation|test|tests|check|checks|lint|typecheck|build|smoke|regression)\b/.test(
      text,
    )
  )
    return "validation";
  if (
    /\b(install|reinstall|setup|configure|configuration|doctor|hook|mcp config)\b/.test(
      text,
    )
  )
    return "install";
  if (
    /\b(doc|docs|documentation|readme|review|audit|plan|planning|roadmap|spec|gdd)\b/.test(
      text,
    )
  )
    return "docs";
  return "implementation";
}

function normalizeInternalStepList(steps = []) {
  const seen = new Set();
  const normalized = [];
  for (const [index, item] of steps.entries()) {
    const raw =
      typeof item === "object" && item !== null ? item : { title: item };
    const title = String(
      raw.title || raw.text || raw.summary || raw.name || "",
    ).trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const status = normalizeInternalStepStatus(raw.status);
    normalized.push(
      omitEmpty({
        id: raw.id ? String(raw.id) : `step_${shortHash(`${title}:${index}`)}`,
        title,
        status,
        kind: raw.kind ? String(raw.kind) : undefined,
        source: raw.source ? String(raw.source) : undefined,
        updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
        completedAt: raw.completedAt ? String(raw.completedAt) : undefined,
      }),
    );
  }
  return normalized;
}

function normalizeInternalStepStatus(status) {
  const value = String(status || "pending").toLowerCase();
  if (value === "complete" || value === "completed") return "done";
  if (["pending", "active", "done", "blocked", "skipped"].includes(value))
    return value;
  return "pending";
}

function mergeInternalSteps(existing = [], incoming = []) {
  const merged = normalizeInternalStepList(existing);
  const byTitle = new Map(
    merged.map((step, index) => [step.title.toLowerCase(), index]),
  );
  for (const step of normalizeInternalStepList(incoming)) {
    const key = step.title.toLowerCase();
    const existingIndex = byTitle.get(key);
    if (existingIndex === undefined) {
      byTitle.set(key, merged.length);
      merged.push(step);
    } else {
      merged[existingIndex] = {
        ...step,
        ...merged[existingIndex],
        status: merged[existingIndex].status || step.status || "pending",
      };
    }
  }
  return merged;
}

/** @param {Record<string, any>} existing @param {Record<string, any>} incoming */
function mergeTaskMetadata(existing = {}, incoming = {}) {
  // Caller steering owns ordinary descriptive metadata. Lifecycle fields and
  // append-only history remain domain-owned and cannot be forged by input.
  const lifecycleKeys = new Set([
    "internalSteps",
    "blocker",
    "blockedAt",
    "completedAt",
    "resumedAt",
    "resumeReason",
    "supersededByPrompt",
    "reason",
  ]);
  const historyKeys = new Set([
    "reopened",
    "consolidatedFrom",
    "createdProvenance",
    "legacySessionClaimedAt",
  ]);
  const editableIncoming = Object.fromEntries(
    Object.entries(incoming).filter(
      ([key]) => !lifecycleKeys.has(key) && !historyKeys.has(key),
    ),
  );
  const preserved = Object.fromEntries(
    Object.entries(existing).filter(
      ([key]) => lifecycleKeys.has(key) || historyKeys.has(key),
    ),
  );
  return { ...existing, ...editableIncoming, ...preserved };
}

function resetInternalStepsForReopen(steps = []) {
  return normalizeInternalStepList(steps).map((step, index) =>
    omitEmpty({
      ...step,
      status: index === 0 ? "active" : "pending",
      reopenedAt: nowIso(),
      completedAt: undefined,
    }),
  );
}

function suspendInternalStepProgress(metadata = {}) {
  const internalSteps = normalizeInternalStepList(
    metadata.internalSteps || [],
  ).map((step) =>
    step.status === "active" ? markInternalStep(step, "pending") : step,
  );
  return internalSteps.length ? { ...metadata, internalSteps } : metadata || {};
}

function terminalizeInternalSteps(metadata = {}) {
  const internalSteps = normalizeInternalStepList(
    metadata.internalSteps || [],
  ).map((step) =>
    ["done", "skipped"].includes(step.status)
      ? step
      : markInternalStep(step, "skipped"),
  );
  return internalSteps.length ? { ...metadata, internalSteps } : metadata || {};
}

function ensureInternalStepProgress(metadata = {}, taskStatus = "pending") {
  const internalSteps = normalizeInternalStepList(metadata.internalSteps || []);
  if (!internalSteps.length) return metadata || {};
  if (taskStatus === "done")
    return {
      ...metadata,
      internalSteps: internalSteps.map((step) =>
        markInternalStep(step, "done"),
      ),
    };
  if (
    taskStatus === "active" &&
    !internalSteps.some((step) => step.status === "active")
  ) {
    const index = internalSteps.findIndex((step) => step.status === "pending");
    if (index >= 0)
      internalSteps[index] = markInternalStep(internalSteps[index], "active");
  }
  return { ...metadata, internalSteps };
}

function hasInternalStepUpdate(args = {}) {
  return (
    args.internalStep !== undefined ||
    args.internalStepId !== undefined ||
    args.internalStepTitle !== undefined ||
    args.internalStepIndex !== undefined ||
    args.internalStepStatus !== undefined
  );
}

function updateInternalStepProgress(metadata = {}, args = {}, options = {}) {
  let internalSteps = normalizeInternalStepList(metadata.internalSteps || []);
  if (!internalSteps.length) return metadata || {};
  if (!hasInternalStepUpdate(args))
    return ensureInternalStepProgress(
      { ...metadata, internalSteps },
      options.taskStatus || "active",
    );

  const request = normalizeInternalStepRequest(args);
  let index = findInternalStepIndex(internalSteps, request);
  if (index < 0 && request.title) {
    internalSteps.push({
      id: `step_${shortHash(`${request.title}:${internalSteps.length}`)}`,
      title: request.title,
      status: "pending",
    });
    index = internalSteps.length - 1;
  }
  if (index < 0)
    return ensureInternalStepProgress(
      { ...metadata, internalSteps },
      options.taskStatus || "active",
    );

  const nextStatus = request.status || "done";
  if (nextStatus === "active")
    internalSteps = internalSteps.map((step, stepIndex) =>
      step.status === "active" && stepIndex !== index
        ? markInternalStep(step, "pending")
        : step,
    );
  internalSteps[index] = markInternalStep(internalSteps[index], nextStatus);
  if (nextStatus === "done" && request.advance !== false) {
    const nextIndex = internalSteps.findIndex(
      (step, stepIndex) => stepIndex > index && step.status === "pending",
    );
    if (nextIndex >= 0)
      internalSteps[nextIndex] = markInternalStep(
        internalSteps[nextIndex],
        "active",
      );
  }
  return { ...metadata, internalSteps };
}

function normalizeInternalStepRequest(args = {}) {
  const raw =
    typeof args.internalStep === "object" && args.internalStep !== null
      ? args.internalStep
      : {};
  const title =
    typeof args.internalStep === "string"
      ? args.internalStep
      : raw.title || raw.text || raw.summary || args.internalStepTitle || null;
  return omitEmpty({
    id: raw.id || args.internalStepId,
    title: title ? String(title).trim() : undefined,
    index: Number.isInteger(raw.index)
      ? raw.index
      : Number.isInteger(args.internalStepIndex)
        ? args.internalStepIndex
        : undefined,
    status: normalizeInternalStepStatus(
      raw.status || args.internalStepStatus || "done",
    ),
    advance: raw.advance ?? args.advanceInternalStep,
  });
}

function findInternalStepIndex(steps, request) {
  if (request.id) {
    const idIndex = steps.findIndex((step) => step.id === request.id);
    if (idIndex >= 0) return idIndex;
  }
  if (
    Number.isInteger(request.index) &&
    request.index >= 0 &&
    request.index < steps.length
  )
    return request.index;
  if (request.title) {
    const key = request.title.toLowerCase();
    return steps.findIndex((step) => step.title.toLowerCase() === key);
  }
  return -1;
}

function markInternalStep(step, status) {
  const normalizedStatus = normalizeInternalStepStatus(status);
  return omitEmpty({
    ...step,
    status: normalizedStatus,
    updatedAt: nowIso(),
    completedAt: ["done", "skipped"].includes(normalizedStatus)
      ? step.completedAt || nowIso()
      : undefined,
  });
}

function normalizeCompletedInternalSteps(metadata = {}) {
  const internalSteps = normalizeInternalStepList(metadata.internalSteps || []);
  if (!internalSteps.length) return metadata || {};
  return { ...metadata, internalSteps };
}

function assertInternalStepsComplete(metadata = {}) {
  const internalSteps = normalizeInternalStepList(metadata.internalSteps || []);
  if (!internalSteps.length) return;
  const incomplete = internalSteps.filter(
    (step) => !["done", "skipped"].includes(step.status),
  );
  assertCondition(
    incomplete.length === 0,
    `Complete all internal steps before completing this route segment: ${incomplete.map((step) => step.title).join("; ")}`,
    "INTERNAL_STEPS_INCOMPLETE",
    { incompleteInternalSteps: incomplete },
  );
}

function findRelatedOpenTask(tasks, candidate) {
  const open = tasks.filter(
    (task) => !["done", "dropped", "superseded"].includes(task.status),
  );
  // Automatic reconciliation is deterministic: fuzzy title similarity can
  // collapse distinct user requirements and is therefore never authoritative.
  return open.find((task) => task.stableKey === candidate.stableKey) || null;
}

function findRelatedReopenableTask(tasks, candidate) {
  const reopenable = tasks.filter((task) =>
    ["done", "dropped", "superseded", "blocked"].includes(task.status),
  );
  return (
    reopenable.find((task) => task.stableKey === candidate.stableKey) || null
  );
}

function assertTaskListTransitions(beforeTasks, afterTasks) {
  const beforeById = new Map(beforeTasks.map((task) => [task.id, task]));
  for (const task of afterTasks) {
    const before = beforeById.get(task.id);
    if (before)
      assertTaskTransition(before.status, task.status, { taskId: task.id });
  }
}

function chooseCurrentTask(tasks, previousCurrentId = null, options = {}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const open = tasks.filter(
    (task) =>
      task.required &&
      !["done", "dropped", "superseded"].includes(task.status) &&
      (task.metadata?.dependsOn || []).every((id) =>
        ["done", "dropped", "superseded"].includes(byId.get(id)?.status),
      ),
  );
  if (!open.length) return null;
  const previous = open.find((task) => task.id === previousCurrentId);
  if (options.forcePreferred && previous) return previous;
  const active = open.find((task) => task.status === "active");
  if (active) return active;
  if (previous) return previous;
  return [...open].sort(
    (a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0),
  )[0];
}

function activateTaskList(tasks, current) {
  return tasks.map((task) => {
    if (task.status === "active" && task.id !== current?.id)
      return {
        ...task,
        status: "pending",
        metadata: suspendInternalStepProgress(task.metadata),
      };
    if (current && task.id === current.id)
      return {
        ...task,
        status: task.status === "pending" ? "active" : task.status,
        metadata: ensureInternalStepProgress(
          task.metadata,
          task.status === "pending" ? "active" : task.status,
        ),
      };
    return task;
  });
}

function assertDependenciesTerminal(task, tasks) {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const incomplete = (task.metadata?.dependsOn || []).filter(
    (id) => !["done", "dropped", "superseded"].includes(byId.get(id)?.status),
  );
  assertCondition(
    incomplete.length === 0,
    "Task dependencies must be terminal before activation.",
    "DEPENDENCIES_INCOMPLETE",
    { taskId: task.id, incomplete },
  );
}

function normalizeDependsOn(value) {
  if (value == null) return [];
  assertCondition(
    Array.isArray(value),
    "dependsOn must be an array.",
    "INVALID_DEPENDENCIES",
  );
  assertCondition(
    value.length <= LIMITS.internalSteps,
    "dependsOn exceeds the maximum item count.",
    "INPUT_TOO_LARGE",
  );
  const ids = value.map((id) =>
    assertNonEmptyString(String(id), "dependency id", LIMITS.id),
  );
  assertCondition(
    new Set(ids).size === ids.length,
    "dependsOn cannot contain duplicate IDs.",
    "DUPLICATE_ID",
  );
  return ids;
}

function assertValidDependencies(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks)
    for (const dependencyId of task.metadata?.dependsOn || []) {
      assertCondition(
        dependencyId !== task.id && byId.has(dependencyId),
        "Task dependency is missing or self-referential.",
        "INVALID_DEPENDENCIES",
      );
    }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id))
      throw new OtmError("Task dependencies contain a cycle.", {
        code: "CYCLIC_DEPENDENCIES",
      });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of byId.get(id).metadata?.dependsOn || [])
      visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function assertCanSwitchTask(tasks, targetTask, args = {}) {
  if (args.allowSwitch === true || args.silent === true) return;
  const active = tasks.find(
    (task) => task.status === "active" && task.required,
  );
  assertCondition(
    !active || active.id === targetTask.id,
    `Complete or explicitly reconcile the active task before moving on: ${active?.title}`,
    "ACTIVE_TASK_INCOMPLETE",
  );
}

function resolveTaskForReopen(change, tasks) {
  if (change.taskId)
    return tasks.find((task) => task.id === change.taskId) || null;
  if (change.stableKey)
    return tasks.find((task) => task.stableKey === change.stableKey) || null;
  if (change.title) {
    const candidate = {
      stableKey:
        change.stableKey ||
        stableTaskKey(
          change.title,
          Array.isArray(change.acceptanceCriteria)
            ? change.acceptanceCriteria
            : [],
        ),
      title: change.title,
    };
    return findRelatedReopenableTask(tasks, candidate);
  }
  return null;
}

function unionStrings(...groups) {
  const seen = new Set();
  const values = [];
  for (const group of groups.flat()) {
    const value = String(group || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function validateHistoricalImport(document, workspaceRoot) {
  assertCondition(
    document && typeof document === "object" && !Array.isArray(document),
    "Import document must be an object.",
    "IMPORT_INVALID",
  );
  assertCondition(
    document.schemaVersion === "otm.export.v1",
    "Unsupported import document schema.",
    "IMPORT_SCHEMA_UNSUPPORTED",
  );
  assertCondition(
    sameWorkspace(document.workspaceRoot, workspaceRoot),
    "Import document belongs to a different workspace.",
    "WORKSPACE_SCOPE_MISMATCH",
  );
  const collections = ["runs", "tasks", "events", "summaries", "cache"];
  for (const collection of collections) {
    assertCondition(
      Array.isArray(document[collection]),
      `Import document has invalid ${collection}.`,
      "IMPORT_INVALID",
    );
    assertUniqueIds(document[collection], collection.slice(0, -1));
  }
  const runs = document.runs.map((run) => ({ ...run, workspaceRoot }));
  const runIds = new Set(runs.map((run) => run.id));
  for (const run of runs) {
    assertKnownEnum(run.status, RUN_STATUSES, "run status");
    assertCondition(
      !["active", "ready_to_finalize", "blocked", "paused"].includes(
        run.status,
      ),
      "Historical import cannot create an active route. Import finalized, cleared, abandoned, or archived history only.",
      "IMPORT_ACTIVE_RUN_FORBIDDEN",
    );
    assertTimestamp(run.createdAt, "run.createdAt");
    assertTimestamp(run.updatedAt, "run.updatedAt");
    assertCondition(
      Boolean(run.finalizedAt),
      "Historical imported runs must include finalizedAt.",
      "IMPORT_INVALID",
    );
    assertTimestamp(run.finalizedAt, "run.finalizedAt");
  }
  for (const task of document.tasks) {
    assertCondition(
      runIds.has(task.runId),
      "Import task references a missing run.",
      "IMPORT_INVALID",
    );
    assertKnownEnum(task.status, TASK_STATUSES, "task status");
    assertTimestamp(task.createdAt, "task.createdAt");
    assertTimestamp(task.updatedAt, "task.updatedAt");
  }
  for (const event of document.events) {
    assertCondition(
      runIds.has(event.runId) &&
        typeof event.idempotencyKey === "string" &&
        event.idempotencyKey,
      "Import event is invalid or references a missing run.",
      "IMPORT_INVALID",
    );
    assertTimestamp(event.createdAt, "event.createdAt");
  }
  for (const summary of document.summaries) {
    assertCondition(
      runIds.has(summary.runId) &&
        sameWorkspace(summary.workspaceRoot, workspaceRoot),
      "Import summary references a missing run or workspace.",
      "IMPORT_INVALID",
    );
    assertTimestamp(summary.createdAt, "summary.createdAt");
  }
  for (const entry of document.cache) {
    assertCondition(
      sameWorkspace(entry.workspaceRoot, workspaceRoot),
      "Import memory entry belongs to a different workspace.",
      "WORKSPACE_SCOPE_MISMATCH",
    );
    assertTimestamp(entry.createdAt, "memory.createdAt");
    assertTimestamp(entry.updatedAt, "memory.updatedAt");
  }
  return {
    runs,
    tasks: document.tasks,
    events: document.events,
    summaries: document.summaries,
    cache: document.cache,
  };
}

function assertTimestamp(value, name) {
  assertCondition(
    typeof value === "string" && Number.isFinite(Date.parse(value)),
    `Import field ${name} must be an ISO timestamp.`,
    "IMPORT_INVALID",
  );
}

function importDocumentCounts(document) {
  return Object.fromEntries(
    ["runs", "tasks", "events", "summaries", "cache"].map((name) => [
      name,
      document[name].length,
    ]),
  );
}

function scoreEntry(entry, query) {
  const scoreHint = Number(entry.scoreHint || 0);
  const reasons = [];
  const normalizedQuery = String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!normalizedQuery) {
    if (scoreHint) reasons.push(`score hint: ${scoreHint}`);
    return { score: scoreHint, matchReasons: reasons };
  }
  const queryTokens = tokenize(normalizedQuery);
  const title = String(entry.title || "").toLowerCase();
  const body = String(entry.body || "").toLowerCase();
  const tags = (entry.tags || []).map((tag) => String(tag).toLowerCase());
  const titleTokens = new Set(tokenize(title));
  const bodyTokens = new Set(tokenize(body));
  const tagTokens = new Set(tokenize(tags.join(" ")));
  let score = scoreHint;
  if (
    title.includes(normalizedQuery) ||
    body.includes(normalizedQuery) ||
    tags.some((tag) => tag.includes(normalizedQuery))
  ) {
    score += 5;
    reasons.push("exact phrase");
  }
  const titleMatches = queryTokens.filter((token) => titleTokens.has(token));
  const tagMatches = queryTokens.filter((token) => tagTokens.has(token));
  const bodyMatches = queryTokens.filter((token) => bodyTokens.has(token));
  if (titleMatches.length) {
    score += titleMatches.length * 3;
    reasons.push(`title: ${titleMatches.join(", ")}`);
  }
  if (tagMatches.length) {
    score += tagMatches.length * 2;
    reasons.push(`tags: ${tagMatches.join(", ")}`);
  }
  if (bodyMatches.length) {
    score += bodyMatches.length;
    reasons.push(`body: ${bodyMatches.join(", ")}`);
  }
  const updatedAt = Date.parse(entry.updatedAt || entry.createdAt || "");
  if (Number.isFinite(updatedAt)) {
    const ageDays = (Date.now() - updatedAt) / 86_400_000;
    if (ageDays >= 0 && ageDays <= 7) {
      score += 1;
      reasons.push("updated within 7 days");
    } else if (ageDays >= 0 && ageDays <= 30) {
      score += 0.5;
      reasons.push("updated within 30 days");
    }
  }
  if (scoreHint) reasons.push(`score hint: ${scoreHint}`);
  return { score, matchReasons: reasons };
}
