import {
  renderCompactSnapshotMarkdown,
  renderDeltaMarkdown,
} from "../core/renderer.mjs";

const MAX_VISIBLE_TASKS = 12;
const MAX_VISIBLE_INTERNAL_STEPS = 12;
const MAX_VISIBLE_MINI_STEPS = 12;
const MAX_VISIBLE_WORKSPACE_ALIASES = 8;
const MAX_VISIBLE_WORKSPACE_ALIAS_BYTES = 2_048;

const MAX_DETAIL_SOURCE_ENTRY_CHARS = 4_000;

export function toMcpResult(result, { detail = false } = {}) {
  const visibleResult = detail
    ? boundDetailResult(result)
    : compactRouteResult(result);
  return {
    content: [
      {
        type: "text",
        text: visibleResult?.markdown || renderPlainResult(visibleResult),
      },
    ],
    // MCP clients that understand structuredContent receive a machine-safe
    // companion payload with a stable envelope; Markdown remains the
    // human-facing representation and arbitrary operation fields stay inside
    // `result` rather than leaking into the protocol root.
    structuredContent: {
      ok: true,
      result: sanitizeStructuredResult(visibleResult),
    },
  };
}

/**
 * Detail stays a full route dump, but accumulated prompt sources can reach
 * hundreds of KB and appear twice (run metadata and snapshot). Keep one copy
 * and cap each entry's text so a detail read fits a client tool result.
 */
function boundDetailResult(result) {
  if (!result || typeof result !== "object") return result;
  const bounded = { ...result };
  const snapshotDigest = result.snapshot?.sourceContext?.digest;
  if (bounded.snapshot?.sourceContext)
    bounded.snapshot = {
      ...bounded.snapshot,
      sourceContext: boundSourceContext(bounded.snapshot.sourceContext),
    };
  const runContext = result.run?.metadata?.sourceContext;
  if (runContext)
    bounded.run = {
      ...result.run,
      metadata: {
        ...result.run.metadata,
        sourceContext:
          snapshotDigest && runContext.digest === snapshotDigest
            ? {
                digest: runContext.digest,
                entryCount: runContext.entryCount,
                totalBytes: runContext.totalBytes,
                sameAs: "snapshot.sourceContext",
              }
            : boundSourceContext(runContext),
      },
    };
  return bounded;
}

function boundSourceContext(context) {
  if (!Array.isArray(context?.entries)) return context;
  return {
    ...context,
    entries: context.entries.map((entry) => {
      if (
        !entry ||
        typeof entry.text !== "string" ||
        entry.text.length <= MAX_DETAIL_SOURCE_ENTRY_CHARS
      )
        return entry;
      return {
        ...entry,
        text: `${entry.text.slice(0, MAX_DETAIL_SOURCE_ENTRY_CHARS)}… [${entry.text.length - MAX_DETAIL_SOURCE_ENTRY_CHARS} more characters stored in OTM]`,
        textTruncated: true,
      };
    }),
  };
}

function compactRouteResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    !result.snapshot ||
    !Array.isArray(result.snapshot.tasks) ||
    !result.snapshot.progress
  )
    return result;
  const snapshot = compactSnapshot(result.snapshot);
  const markdownSnapshot = compactMarkdownSnapshot(result.snapshot);
  const markdown =
    result.snapshot.lastUpdate?.kind === "stop_audit"
      ? renderCompactSnapshotMarkdown(markdownSnapshot, {
          title: "OTM Stop audit",
        })
      : result.snapshot.lastUpdate?.kind === "run_started" ||
          result.snapshot.lastUpdate?.kind === "run_reconciled" ||
          result.snapshot.lastUpdate?.kind === "task_completed" ||
          result.snapshot.lastUpdate?.kind === "task_started" ||
          result.snapshot.lastUpdate?.kind === "task_blocked" ||
          result.snapshot.lastUpdate?.kind === "progress"
        ? renderDeltaMarkdown(markdownSnapshot)
        : renderCompactSnapshotMarkdown(markdownSnapshot);
  const {
    summary: fullSummary,
    summaryJson: _summaryJson,
    summaryMd: _summaryMd,
    metadata: _metadata,
    sourceContext: _sourceContext,
    evidence: _evidence,
    ...compactFields
  } = result;
  const visible = { ...compactFields, snapshot, markdown };
  if (result.run) visible.run = compactRun(result.run);
  if (fullSummary && typeof fullSummary === "object")
    visible.summary = pick(fullSummary, [
      "id",
      "runId",
      "turnId",
      "createdAt",
      "currentCleared",
    ]);
  if (result.canonicalIdentity)
    visible.canonicalIdentity = compactIdentity(result.canonicalIdentity);
  if (Array.isArray(result.remainingRequired)) {
    visible.remainingRequired = result.remainingRequired
      .slice(0, MAX_VISIBLE_TASKS)
      .map(compactTask);
    if (result.remainingRequired.length > MAX_VISIBLE_TASKS)
      visible.remainingRequiredOmitted =
        result.remainingRequired.length - MAX_VISIBLE_TASKS;
    visible.remainingRequiredCount = result.remainingRequired.length;
  }
  return visible;
}

function compactRun(run = {}) {
  const compact = pick(run, [
    "id",
    "status",
    "goal",
    "routeRevision",
    "currentTaskId",
    "createdAt",
    "updatedAt",
    "finalizedAt",
  ]);
  if (compact.goal) compact.goal = compactText(compact.goal, 800);
  return compact;
}

function compactIdentity(identity = {}) {
  const compact = pick(identity, [
    "resolution",
    "canonicalTaskId",
    "primaryWorkspace",
    "stopResolvedTaskId",
    "modelReasoningRequired",
  ]);
  if (Array.isArray(identity.workspaceAliases)) {
    const aliases = [];
    let aliasBytes = 0;
    let omitted = 0;
    for (const alias of identity.workspaceAliases) {
      if (typeof alias !== "string") {
        omitted += 1;
        continue;
      }
      const bytes = Buffer.byteLength(alias, "utf8");
      if (
        aliases.length >= MAX_VISIBLE_WORKSPACE_ALIASES ||
        aliasBytes + bytes > MAX_VISIBLE_WORKSPACE_ALIAS_BYTES
      ) {
        omitted += 1;
        continue;
      }
      aliases.push(alias);
      aliasBytes += bytes;
    }
    compact.workspaceAliases = aliases;
    if (omitted > 0) compact.workspaceAliasesOmittedCount = omitted;
  }
  return compact;
}

function compactSnapshot(snapshot = {}) {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const required = tasks.filter((task) => task.required);
  const keep = new Set(
    tasks.slice(0, MAX_VISIBLE_TASKS).map((task) => task.id),
  );
  if (snapshot.currentTaskId) keep.add(snapshot.currentTaskId);
  if (snapshot.lastUpdate?.taskId) keep.add(snapshot.lastUpdate.taskId);
  const visibleTasks = tasks
    .filter((task) => keep.has(task.id))
    .map((task) => compactTask(task, task.id === snapshot.currentTaskId));
  const compact = {
    ...pick(snapshot, [
      "schemaVersion",
      "manager",
      "status",
      "runId",
      "goal",
      "routeRevision",
      "renderRevision",
      "phase",
      "stopAllowed",
      "stopReason",
      "progress",
      "currentTaskId",
      "currentTaskTitle",
      "currentInternalStep",
      "lastUpdate",
      "updatedAt",
    ]),
    taskCount: tasks.length,
    requiredTaskCount: required.length,
    omittedTaskCount: Math.max(0, tasks.length - visibleTasks.length),
    tasks: visibleTasks,
  };
  for (const key of ["goal", "currentTaskTitle", "stopReason"])
    if (compact[key]) compact[key] = compactText(compact[key], 500);
  if (compact.currentInternalStep)
    compact.currentInternalStep = compactInternalStep(
      compact.currentInternalStep,
    );
  if (compact.lastUpdate)
    compact.lastUpdate = compactLastUpdate(compact.lastUpdate);
  return compact;
}

function compactTask(task = {}, includeDescendants = false) {
  const compact = pick(task, [
    "id",
    "title",
    "status",
    "required",
    "workType",
    "active",
  ]);
  if (compact.title) compact.title = compactText(compact.title, 300);
  if (!includeDescendants) return compact;
  const steps = Array.isArray(task.internalSteps) ? task.internalSteps : [];
  compact.internalStepCount = steps.length;
  compact.omittedInternalStepCount = Math.max(
    0,
    steps.length - MAX_VISIBLE_INTERNAL_STEPS,
  );
  compact.internalSteps = steps
    .slice(0, MAX_VISIBLE_INTERNAL_STEPS)
    .map((step) => {
      const miniSteps = Array.isArray(step.miniSteps) ? step.miniSteps : [];
      const compactStep = {
        ...pick(step, [
          "id",
          "title",
          "status",
          "required",
          "evidenceRequired",
          "atomic",
        ]),
        miniStepCount: miniSteps.length,
        omittedMiniStepCount: Math.max(
          0,
          miniSteps.length - MAX_VISIBLE_MINI_STEPS,
        ),
        miniSteps: miniSteps.slice(0, MAX_VISIBLE_MINI_STEPS).map((mini) => {
          const compactMini = pick(mini, [
            "id",
            "title",
            "status",
            "required",
            "evidenceRequired",
          ]);
          if (compactMini.title)
            compactMini.title = compactText(compactMini.title, 240);
          return compactMini;
        }),
      };
      if (compactStep.title)
        compactStep.title = compactText(compactStep.title, 240);
      return compactStep;
    });
  return compact;
}

function compactMarkdownSnapshot(snapshot = {}) {
  return {
    ...snapshot,
    goal: compactText(snapshot.goal || "", 800),
    currentTaskTitle: compactText(snapshot.currentTaskTitle || "", 300),
    stopReason: compactText(snapshot.stopReason || "", 300),
    lastUpdate: snapshot.lastUpdate
      ? compactLastUpdate(snapshot.lastUpdate)
      : undefined,
  };
}

function compactInternalStep(step = {}) {
  const compact = pick(step, ["id", "title", "status", "done", "total"]);
  if (compact.title) compact.title = compactText(compact.title, 240);
  if (step.mini?.current)
    compact.mini = {
      ...pick(step.mini, ["done", "total"]),
      current: pick(step.mini.current, ["id", "title", "status"]),
    };
  if (compact.mini?.current?.title)
    compact.mini.current.title = compactText(compact.mini.current.title, 200);
  return compact;
}

function compactLastUpdate(update = {}) {
  const compact = pick(update, ["kind", "taskId", "at", "message"]);
  if (compact.message) compact.message = compactText(compact.message, 500);
  return compact;
}

function compactText(value, limit) {
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function pick(value, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

function sanitizeStructuredResult(value) {
  if (value === undefined) return { ok: true };
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (/authorization|token|secret|password|private.?key/i.test(key))
        return "[REDACTED]";
      return item;
    }),
  );
}

function renderPlainResult(result) {
  if (!result) return "OTM command completed.";
  if (Array.isArray(result.entries))
    return `OTM memory search returned ${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"}.`;
  if (Array.isArray(result.runs))
    return `OTM found ${result.runs.length} run${result.runs.length === 1 ? "" : "s"}.`;
  if (typeof result.deleted === "number")
    return `OTM removed ${result.deleted} matching entr${result.deleted === 1 ? "y" : "ies"}.`;
  if (result.entry?.title) return `OTM memory updated: ${result.entry.title}`;
  if (result.cleared) return "OTM active route cleared.";
  if (typeof result.stopAllowed === "boolean")
    return result.stopAllowed
      ? "OTM audit passed. Stop is allowed."
      : "OTM audit blocked. Required route segments remain open.";
  return "OTM command completed.";
}
