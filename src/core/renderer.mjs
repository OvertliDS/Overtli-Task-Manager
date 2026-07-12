import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  MANAGER_NAME,
} from "./constants.mjs";
import {
  markdownEscapeCell,
  markdownEscapeText,
  compactOneLine,
} from "./text-utils.mjs";
import {
  cleanupWorkspaceStateTempFiles,
  currentJsonPath,
  currentMarkdownPath,
  relativeToWorkspace,
  atomicWriteJson,
  atomicWriteText,
  workspaceStateDir,
  workspaceTempDir,
  readOtmJsonArtifact,
} from "./fs-utils.mjs";

export const DEFAULT_RENDER_POLICY = {
  mode: "start_end_delta",
  showFullOnStart: true,
  showFullOnFinal: true,
  showFullOnSteering: true,
  showFullOnManualStatus: true,
  showFullOnCheckpoint: false,
  showDeltaOnProgress: true,
  suppressNoopUpdates: true,
};

export function buildSnapshot({
  run,
  tasks,
  workspaceRoot,
  storageKind = "unknown",
  lastUpdate = null,
}) {
  const required = tasks.filter(
    (task) => task.required && !["dropped", "superseded"].includes(task.status),
  );
  const optional = tasks.filter(
    (task) =>
      !task.required && !["dropped", "superseded"].includes(task.status),
  );
  const requiredDone = required.filter((task) => task.status === "done").length;
  const optionalDone = optional.filter((task) => task.status === "done").length;
  const remainingRequired = required.filter(
    (task) => !["done"].includes(task.status),
  );
  const currentTask =
    tasks.find((task) => task.id === run.currentTaskId) ||
    tasks.find((task) => task.status === "active") ||
    remainingRequired[0] ||
    null;
  const displayTasks = sortTasksForDisplay(tasks, currentTask);
  const currentInternal = currentTask
    ? summarizeInternalSteps(currentTask.metadata?.internalSteps || [])
    : null;
  const stopAllowed = remainingRequired.length === 0;
  const renderedMode = deriveRenderedMode(lastUpdate);
  const renderHash = hashRenderState({
    renderedMode,
    run,
    tasks: displayTasks,
    currentTask,
    requiredDone,
    requiredTotal: required.length,
    optionalDone,
    optionalTotal: optional.length,
    lastUpdate,
  });

  return omitEmpty({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    manager: MANAGER_NAME,
    status: run.status,
    runId: run.id,
    workspaceRoot,
    goal: run.goal,
    routeRevision: run.routeRevision || 1,
    renderRevision: run.metadata?.renderRevision || run.routeRevision || 1,
    renderPolicy: DEFAULT_RENDER_POLICY,
    lastRenderedMode: renderedMode,
    lastRenderedTaskId: currentTask?.id || undefined,
    lastRenderedHash: renderHash,
    phase: derivePhase(tasks),
    stopAllowed,
    stopReason: stopAllowed
      ? "All required route segments are complete."
      : `${remainingRequired.length} required route segment${remainingRequired.length === 1 ? "" : "s"} remain open.`,
    progress: {
      requiredDone,
      requiredTotal: required.length,
      optionalDone,
      optionalTotal: optional.length,
      percentRequired: required.length
        ? Math.round((requiredDone / required.length) * 100)
        : 100,
    },
    sessionId: run.sessionId || undefined,
    turnId: run.turnId || undefined,
    gitBranch: run.metadata?.gitBranch || undefined,
    currentTaskId: currentTask?.id || undefined,
    currentTaskTitle: currentTask?.title || undefined,
    currentInternalStep: currentInternal?.current
      ? omitEmpty({
          id: currentInternal.current.id,
          title: currentInternal.current.title,
          status: currentInternal.current.status,
          done: currentInternal.done,
          total: currentInternal.total,
        })
      : undefined,
    checklist: displayTasks.map((task) =>
      omitEmpty({
        id: task.id,
        title: task.title,
        status: task.status,
        checked: task.status === "done",
        active: task.id === currentTask?.id,
        required: Boolean(task.required),
        internal: summarizeInternalSteps(task.metadata?.internalSteps || []),
        evidence: renderEvidenceBrief(task.evidence || []),
      }),
    ),
    tasks: displayTasks.map((task) => {
      const internalSteps = normalizeInternalStepList(
        task.metadata?.internalSteps || [],
      );
      const { internalSteps: _internalSteps, ...snapshotMetadata } =
        task.metadata || {};
      return {
        id: task.id,
        title: task.title,
        ...(task.description ? { description: task.description } : {}),
        status: task.status,
        required: Boolean(task.required),
        priority: task.priority,
        sortOrder: task.sortOrder,
        acceptanceCriteria: task.acceptanceCriteria || [],
        evidence: (task.evidence || []).map(sanitizeEvidence),
        createdBy: task.createdBy,
        updatedAt: task.updatedAt,
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
        internalSteps,
        metadata: snapshotMetadata,
      };
    }),
    lastUpdate: lastUpdate || undefined,
    storage: { kind: storageKind },
    paths: {
      currentJson: relativeToWorkspace(
        workspaceRoot,
        currentJsonPath(workspaceRoot, run.sessionId),
      ),
      currentMarkdown: relativeToWorkspace(
        workspaceRoot,
        currentMarkdownPath(workspaceRoot, run.sessionId),
      ),
    },
    // A snapshot is a view of durable route state. Do not stamp a fresh time
    // merely because it was rendered; that defeats no-op file suppression.
    updatedAt: run.updatedAt,
  });
}

export function renderSnapshotMarkdown(snapshot, options = {}) {
  const title = options.title || "Overtli Task Manager";
  const active =
    snapshot.status === "active" ||
    snapshot.status === "blocked" ||
    snapshot.status === "paused";
  const statusIcon = snapshot.stopAllowed ? "✅" : "🧭";
  const current = snapshot.currentTaskTitle
    ? `**Current:** ${markdownEscapeText(snapshot.currentTaskTitle)}`
    : "**Current:** no active route segment";
  const stop = snapshot.stopAllowed
    ? "Stop allowed"
    : `Stop blocked — ${snapshot.stopReason}`;
  const lines = [];
  lines.push(`## ${statusIcon} ${title}`);
  lines.push("");
  lines.push(
    `**Goal:** ${markdownEscapeText(snapshot.goal || "No active goal")}`,
  );
  lines.push(
    `**Progress:** ${snapshot.progress.requiredDone}/${snapshot.progress.requiredTotal} required complete (${snapshot.progress.percentRequired}%)`,
  );
  lines.push(`${current}`);
  if (snapshot.currentInternalStep) {
    lines.push(
      `**Internal:** ${snapshot.currentInternalStep.done}/${snapshot.currentInternalStep.total} done; ${taskIcon(snapshot.currentInternalStep.status)} ${markdownEscapeText(snapshot.currentInternalStep.title)}`,
    );
  }
  lines.push(`**Gate:** ${stop}`);
  lines.push("");
  if (snapshot.lastUpdate?.message) {
    lines.push(`> ${markdownEscapeText(snapshot.lastUpdate.message)}`);
    lines.push("");
  }
  lines.push("| State | Task | Evidence |");
  lines.push("|---|---|---|");
  for (const task of snapshot.tasks) {
    lines.push(
      `| ${taskIcon(task.status)} | ${markdownEscapeCell(task.title)}${task.required ? "" : " _(optional)_"} | ${markdownEscapeCell(renderTaskBrief(task))} |`,
    );
  }
  if (!snapshot.tasks.length) {
    lines.push("| — | No tasks are active. | — |");
  }
  lines.push("");
  if (active)
    lines.push(
      `_Route revision ${snapshot.routeRevision}. State file: \`${snapshot.paths.currentJson}\`._`,
    );
  else
    lines.push(
      `_No active route. Last state file: \`${snapshot.paths.currentJson}\`._`,
    );
  return `${lines.join("\n")}\n`;
}

export function renderDeltaMarkdown(snapshot, options = {}) {
  const title = options.title || "OTM Progress";
  const lines = [];
  lines.push(`### ${title}`);
  if (snapshot.lastUpdate?.message)
    lines.push(markdownEscapeText(snapshot.lastUpdate.message));
  const completed = lastCompletedTask(snapshot);
  if (completed)
    lines.push(`✅ Completed: ${markdownEscapeText(completed.title)}`);
  if (snapshot.currentTaskTitle && !snapshot.stopAllowed)
    lines.push(`▶ Now: ${markdownEscapeText(snapshot.currentTaskTitle)}`);
  lines.push(
    `Gate: ${snapshot.stopAllowed ? "Stop allowed" : snapshot.stopReason}`,
  );
  return `${lines.join("\n")}\n`;
}

export function writeCurrentFiles(workspaceRoot, snapshot) {
  // Validate existing artifacts before any write. A damaged snapshot must not
  // be silently replaced by a new render, because doctor/repair needs the
  // original bytes to diagnose and recover it.
  readOtmJsonArtifact(currentJsonPath(workspaceRoot, snapshot.sessionId));
  if (snapshot.sessionId) readOtmJsonArtifact(currentJsonPath(workspaceRoot));
  cleanupWorkspaceStateTempFiles(
    workspaceRoot,
    snapshot.sessionId ? { sessionId: snapshot.sessionId } : {},
  );
  const tempDir = workspaceTempDir(workspaceRoot);
  const jsonChanged = atomicWriteJson(
    currentJsonPath(workspaceRoot, snapshot.sessionId),
    snapshot,
    { tempDir },
  );
  const markdownChanged = atomicWriteText(
    currentMarkdownPath(workspaceRoot, snapshot.sessionId),
    renderSnapshotMarkdown(snapshot),
    { tempDir },
  );
  const indexChanged = snapshot.sessionId
    ? writeWorkspaceCurrentIndex(workspaceRoot, { tempDir })
    : { jsonChanged: false, markdownChanged: false };
  cleanupWorkspaceStateTempFiles(
    workspaceRoot,
    snapshot.sessionId ? { sessionId: snapshot.sessionId } : {},
  );
  return { jsonChanged, markdownChanged, indexChanged };
}

export function writeWorkspaceCurrentIndex(workspaceRoot, options = {}) {
  return withWorkspaceIndexLock(workspaceRoot, () =>
    writeWorkspaceCurrentIndexUnlocked(workspaceRoot, options),
  );
}

function writeWorkspaceCurrentIndexUnlocked(workspaceRoot, options = {}) {
  const tempDir = options.tempDir || workspaceTempDir(workspaceRoot);
  const sessionsRoot = path.join(workspaceStateDir(workspaceRoot), "sessions");
  const sessions = [];
  if (fs.existsSync(sessionsRoot)) {
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const snapshot = readOtmJsonArtifact(
        path.join(sessionsRoot, entry.name, "current.json"),
      );
      if (
        !snapshot ||
        !["active", "ready_to_finalize", "blocked", "paused"].includes(
          snapshot.status,
        )
      )
        continue;
      sessions.push({
        sessionKey: entry.name,
        runId: snapshot.runId,
        goal: snapshot.goal,
        status: snapshot.status,
        currentTaskId: snapshot.currentTaskId,
        currentTaskTitle: snapshot.currentTaskTitle,
        stopAllowed: snapshot.stopAllowed,
        updatedAt: snapshot.updatedAt,
        paths: snapshot.paths,
      });
    }
  }
  sessions.sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
  const index = {
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    manager: MANAGER_NAME,
    status: sessions.length
      ? sessions.length === 1
        ? sessions[0].status
        : "multi_session"
      : "cleared",
    workspaceRoot,
    activeSessionCount: sessions.length,
    sessions,
    updatedAt: new Date().toISOString(),
  };
  const currentPath = currentJsonPath(workspaceRoot);
  const previous = readOtmJsonArtifact(currentPath);
  if (previous && sameIndexState(previous, index))
    index.updatedAt = previous.updatedAt;
  const markdown = renderWorkspaceCurrentIndexMarkdown(index);
  return {
    jsonChanged: atomicWriteJson(currentPath, index, { tempDir }),
    markdownChanged: atomicWriteText(
      currentMarkdownPath(workspaceRoot),
      markdown,
      { tempDir },
    ),
    index,
  };
}

function sameIndexState(left, right) {
  const { updatedAt: _leftUpdatedAt, ...leftComparable } = left;
  const { updatedAt: _rightUpdatedAt, ...rightComparable } = right;
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

function withWorkspaceIndexLock(workspaceRoot, fn) {
  const lockPath = path.join(
    workspaceTempDir(workspaceRoot),
    "current-index.lock",
  );
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  while (true) {
    let handle = null;
    try {
      handle = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        handle,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          operation: "workspace-current-index",
        }),
        "utf8",
      );
      return fn();
    } catch (error) {
      // Windows can briefly report EPERM while a competing process owns or
      // removes the lock. Treat it as contention only if the lock exists.
      if (
        error?.code !== "EEXIST" &&
        !(error?.code === "EPERM" && fs.existsSync(lockPath))
      )
        throw error;
      const stat = statSafe(lockPath);
      const owner = readIndexLockOwner(lockPath);
      // An aged lock is not enough to take it: a live writer may be handling
      // a large route snapshot. Only a dead owner makes recovery safe.
      if (
        stat &&
        Date.now() - stat.mtimeMs > 30_000 &&
        !isProcessAlive(owner?.pid)
      ) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {}
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `Timed out waiting for OTM workspace index lock: ${lockPath}`,
        );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    } finally {
      if (handle !== null) {
        try {
          fs.closeSync(handle);
        } catch {}
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {}
      }
    }
  }
}

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readIndexLockOwner(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function renderWorkspaceCurrentIndexMarkdown(index) {
  const lines = [
    "# Overtli Task Manager sessions",
    "",
    `Active sessions: ${index.activeSessionCount}`,
    "",
  ];
  if (!index.sessions.length) lines.push("No active session-scoped routes.");
  else {
    lines.push(
      "| Session | Route | Current | State file |",
      "|---|---|---|---|",
    );
    for (const item of index.sessions) {
      lines.push(
        `| \`${item.sessionKey}\` | ${markdownEscapeCell(item.goal || item.runId)} | ${markdownEscapeCell(item.currentTaskTitle || "—")} | \`${item.paths?.currentJson || "—"}\` |`,
      );
    }
  }
  lines.push(
    "",
    "_Use the session-scoped state path returned by OTM tools; this workspace file is an index, not a mutable route._",
  );
  return `${lines.join("\n")}\n`;
}

export function renderSummaryMarkdown(summary) {
  const lines = [];
  lines.push("## ✅ Overtli Task Manager summary");
  lines.push("");
  lines.push(`**Goal:** ${markdownEscapeText(summary.goal)}`);
  lines.push(`**Outcome:** ${markdownEscapeText(summary.outcome)}`);
  lines.push("");
  lines.push("### Completed");
  for (const item of summary.completed)
    lines.push(`- ${markdownEscapeText(item)}`);
  if (!summary.completed.length)
    lines.push("- No required tasks were marked complete.");
  lines.push("");
  if (summary.blocked?.length) {
    lines.push("### Blocked");
    for (const item of summary.blocked)
      lines.push(`- ${markdownEscapeText(item)}`);
    lines.push("");
  }
  if (summary.dropped?.length) {
    lines.push("### Dropped or superseded");
    for (const item of summary.dropped)
      lines.push(`- ${markdownEscapeText(item)}`);
    lines.push("");
  }
  if (summary.evidence?.length) {
    lines.push("### Evidence");
    for (const item of conciseEvidence(summary.evidence).slice(0, 12))
      lines.push(`- ${markdownEscapeText(item)}`);
    lines.push("");
  }
  if (summary.nextSteps?.length) {
    lines.push("### Next route");
    for (const item of summary.nextSteps)
      lines.push(`- ${markdownEscapeText(item)}`);
    lines.push("");
  }
  lines.push(`_Summary saved at ${summary.createdAt}._`);
  return `${lines.join("\n")}\n`;
}

function renderEvidenceBrief(evidence = []) {
  if (!evidence.length) return "—";
  return compactOneLine(
    evidence[evidence.length - 1].summary ||
      evidence[evidence.length - 1].kind ||
      "captured",
    80,
  );
}

function renderTaskBrief(task = {}) {
  const internal = summarizeInternalSteps(
    task.internalSteps || task.metadata?.internalSteps || [],
  );
  const parts = [];
  if (internal?.total) {
    const current = internal.current
      ? `; ${taskIcon(internal.current.status)} ${internal.current.title}`
      : "";
    parts.push(`Internal ${internal.done}/${internal.total}${current}`);
  }
  const evidence = renderEvidenceBrief(task.evidence || []);
  if (evidence !== "—") parts.push(evidence);
  return compactOneLine(parts.join(" | ") || "—", 100);
}

function conciseEvidence(evidence = []) {
  const seen = new Set();
  const out = [];
  for (const item of evidence) {
    const value = compactOneLine(String(item || "").replace(/\s+/g, " "), 180);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function taskIcon(status) {
  switch (status) {
    case "done":
      return "✅ done";
    case "active":
      return "▶ active";
    case "blocked":
      return "⛔ blocked";
    case "dropped":
      return "↘ dropped";
    case "superseded":
      return "↪ superseded";
    default:
      return "○ pending";
  }
}

function omitEmpty(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null,
    ),
  );
}

function sanitizeEvidence(item = {}) {
  return omitEmpty({
    kind: item.kind,
    summary: item.summary,
    files:
      Array.isArray(item.files) && item.files.length ? item.files : undefined,
    command: item.command || undefined,
    exitCode: item.exitCode ?? undefined,
    notes: item.notes || undefined,
    at: item.at,
  });
}

function normalizeInternalStepList(steps = []) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((item) => {
      const raw =
        typeof item === "object" && item !== null ? item : { title: item };
      const title = String(
        raw.title || raw.text || raw.summary || raw.name || "",
      ).trim();
      if (!title) return null;
      const status = normalizeInternalStepStatus(raw.status);
      return omitEmpty({
        id: raw.id ? String(raw.id) : undefined,
        title,
        status,
        kind: raw.kind ? String(raw.kind) : undefined,
        source: raw.source ? String(raw.source) : undefined,
        updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
        completedAt: raw.completedAt ? String(raw.completedAt) : undefined,
      });
    })
    .filter(Boolean);
}

function normalizeInternalStepStatus(status) {
  const value = String(status || "pending").toLowerCase();
  if (value === "complete" || value === "completed") return "done";
  if (["pending", "active", "done", "blocked", "skipped"].includes(value))
    return value;
  return "pending";
}

function summarizeInternalSteps(steps = []) {
  const normalized = normalizeInternalStepList(steps);
  if (!normalized.length) return undefined;
  const done = normalized.filter(
    (step) => step.status === "done" || step.status === "skipped",
  ).length;
  const current =
    normalized.find((step) => step.status === "active") ||
    normalized.find((step) => step.status === "blocked") ||
    normalized.find((step) => step.status === "pending") ||
    normalized.at(-1);
  return { done, total: normalized.length, current };
}

function deriveRenderedMode(lastUpdate) {
  switch (lastUpdate?.kind) {
    case "run_started":
    case "run_reconciled":
      return "full";
    case "turn_finalized":
      return "final";
    case "task_started":
    case "task_completed":
    case "task_blocked":
    case "task_dropped":
    case "task_superseded":
    case "progress":
      return "delta";
    case "stop_audit":
      return "gate";
    default:
      return "full";
  }
}

function hashRenderState(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function lastCompletedTask(snapshot) {
  if (
    snapshot.lastUpdate?.kind === "task_completed" &&
    snapshot.lastUpdate?.taskId
  ) {
    return (
      (snapshot.tasks || []).find(
        (task) => task.id === snapshot.lastUpdate.taskId,
      ) || null
    );
  }
  const done = (snapshot.tasks || []).filter((task) => task.status === "done");
  return done.length === 1 ? done[0] : null;
}

function sortTasksForDisplay(tasks, _currentTask) {
  return [...tasks].sort(
    (a, b) =>
      Number(a.sortOrder || 0) - Number(b.sortOrder || 0) ||
      String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id)),
  );
}

function derivePhase(tasks) {
  if (!tasks.length) return "idle";
  if (tasks.some((task) => task.status === "active")) return "execution";
  if (
    tasks.every((task) =>
      ["done", "dropped", "superseded"].includes(task.status),
    )
  )
    return "complete";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  return "planning";
}
