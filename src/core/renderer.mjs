import crypto from 'node:crypto';
import { CURRENT_SCHEMA_VERSION, MANAGER_NAME } from './constants.mjs';
import { markdownEscapeCell, compactOneLine } from './text-utils.mjs';
import { cleanupWorkspaceStateTempFiles, currentJsonPath, currentMarkdownPath, relativeToWorkspace, atomicWriteJson, atomicWriteText, workspaceTempDir } from './fs-utils.mjs';

export const DEFAULT_RENDER_POLICY = {
  mode: 'start_end_delta',
  showFullOnStart: true,
  showFullOnFinal: true,
  showFullOnSteering: true,
  showFullOnManualStatus: true,
  showFullOnCheckpoint: false,
  showDeltaOnProgress: true,
  suppressNoopUpdates: true
};

export function buildSnapshot({ run, tasks, workspaceRoot, storageKind = 'unknown', lastUpdate = null }) {
  const required = tasks.filter((task) => task.required && !['dropped', 'superseded'].includes(task.status));
  const optional = tasks.filter((task) => !task.required && !['dropped', 'superseded'].includes(task.status));
  const requiredDone = required.filter((task) => task.status === 'done').length;
  const optionalDone = optional.filter((task) => task.status === 'done').length;
  const remainingRequired = required.filter((task) => !['done'].includes(task.status));
  const currentTask = tasks.find((task) => task.id === run.currentTaskId) || tasks.find((task) => task.status === 'active') || remainingRequired[0] || null;
  const displayTasks = sortTasksForDisplay(tasks, currentTask);
  const stopAllowed = remainingRequired.length === 0;
  const renderedMode = deriveRenderedMode(lastUpdate);
  const renderHash = hashRenderState({ renderedMode, run, tasks: displayTasks, currentTask, requiredDone, requiredTotal: required.length, optionalDone, optionalTotal: optional.length, lastUpdate });

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
    stopReason: stopAllowed ? 'All required route segments are complete.' : `${remainingRequired.length} required route segment${remainingRequired.length === 1 ? '' : 's'} remain open.`,
    progress: {
      requiredDone,
      requiredTotal: required.length,
      optionalDone,
      optionalTotal: optional.length,
      percentRequired: required.length ? Math.round((requiredDone / required.length) * 100) : 100
    },
    sessionId: run.sessionId || undefined,
    turnId: run.turnId || undefined,
    gitBranch: run.metadata?.gitBranch || undefined,
    currentTaskId: currentTask?.id || undefined,
    currentTaskTitle: currentTask?.title || undefined,
    checklist: displayTasks.map((task) => omitEmpty({
      id: task.id,
      title: task.title,
      status: task.status,
      checked: task.status === 'done',
      active: task.id === currentTask?.id,
      required: Boolean(task.required),
      evidence: renderEvidenceBrief(task.evidence || [])
    })),
    tasks: displayTasks.map((task) => ({
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
      metadata: task.metadata || {}
    })),
    lastUpdate: lastUpdate || undefined,
    storage: { kind: storageKind },
    paths: {
      currentJson: relativeToWorkspace(workspaceRoot, currentJsonPath(workspaceRoot)),
      currentMarkdown: relativeToWorkspace(workspaceRoot, currentMarkdownPath(workspaceRoot))
    },
    updatedAt: new Date().toISOString()
  });
}

export function renderSnapshotMarkdown(snapshot, options = {}) {
  const title = options.title || 'Overtli Task Manager';
  const active = snapshot.status === 'active' || snapshot.status === 'blocked' || snapshot.status === 'paused';
  const statusIcon = snapshot.stopAllowed ? '✅' : '🧭';
  const current = snapshot.currentTaskTitle ? `**Current:** ${snapshot.currentTaskTitle}` : '**Current:** no active route segment';
  const stop = snapshot.stopAllowed ? 'Stop allowed' : `Stop blocked — ${snapshot.stopReason}`;
  const lines = [];
  lines.push(`## ${statusIcon} ${title}`);
  lines.push('');
  lines.push(`**Goal:** ${snapshot.goal || 'No active goal'}`);
  lines.push(`**Progress:** ${snapshot.progress.requiredDone}/${snapshot.progress.requiredTotal} required complete (${snapshot.progress.percentRequired}%)`);
  lines.push(`${current}`);
  lines.push(`**Gate:** ${stop}`);
  lines.push('');
  if (snapshot.lastUpdate?.message) {
    lines.push(`> ${snapshot.lastUpdate.message}`);
    lines.push('');
  }
  lines.push('| State | Task | Evidence |');
  lines.push('|---|---|---|');
  for (const task of snapshot.tasks) {
    lines.push(`| ${taskIcon(task.status)} | ${markdownEscapeCell(task.title)}${task.required ? '' : ' _(optional)_'} | ${markdownEscapeCell(renderEvidenceBrief(task.evidence))} |`);
  }
  if (!snapshot.tasks.length) {
    lines.push('| — | No tasks are active. | — |');
  }
  lines.push('');
  if (active) lines.push(`_Route revision ${snapshot.routeRevision}. State file: \`${snapshot.paths.currentJson}\`._`);
  else lines.push(`_No active route. Last state file: \`${snapshot.paths.currentJson}\`._`);
  return `${lines.join('\n')}\n`;
}

export function renderDeltaMarkdown(snapshot, options = {}) {
  const title = options.title || 'OTM Progress';
  const lines = [];
  lines.push(`### ${title}`);
  if (snapshot.lastUpdate?.message) lines.push(snapshot.lastUpdate.message);
  const completed = lastCompletedTask(snapshot);
  if (completed) lines.push(`✅ Completed: ${completed.title}`);
  if (snapshot.currentTaskTitle && !snapshot.stopAllowed) lines.push(`▶ Now: ${snapshot.currentTaskTitle}`);
  lines.push(`Gate: ${snapshot.stopAllowed ? 'Stop allowed' : snapshot.stopReason}`);
  return `${lines.join('\n')}\n`;
}

export function writeCurrentFiles(workspaceRoot, snapshot) {
  cleanupWorkspaceStateTempFiles(workspaceRoot);
  const tempDir = workspaceTempDir(workspaceRoot);
  const jsonChanged = atomicWriteJson(currentJsonPath(workspaceRoot), snapshot, { tempDir });
  const markdownChanged = atomicWriteText(currentMarkdownPath(workspaceRoot), renderSnapshotMarkdown(snapshot), { tempDir });
  cleanupWorkspaceStateTempFiles(workspaceRoot);
  return { jsonChanged, markdownChanged };
}

export function renderSummaryMarkdown(summary) {
  const lines = [];
  lines.push('## ✅ Overtli Task Manager summary');
  lines.push('');
  lines.push(`**Goal:** ${summary.goal}`);
  lines.push(`**Outcome:** ${summary.outcome}`);
  lines.push('');
  lines.push('### Completed');
  for (const item of summary.completed) lines.push(`- ${item}`);
  if (!summary.completed.length) lines.push('- No required tasks were marked complete.');
  lines.push('');
  if (summary.blocked?.length) {
    lines.push('### Blocked');
    for (const item of summary.blocked) lines.push(`- ${item}`);
    lines.push('');
  }
  if (summary.dropped?.length) {
    lines.push('### Dropped or superseded');
    for (const item of summary.dropped) lines.push(`- ${item}`);
    lines.push('');
  }
  if (summary.evidence?.length) {
    lines.push('### Evidence');
    for (const item of conciseEvidence(summary.evidence).slice(0, 12)) lines.push(`- ${item}`);
    lines.push('');
  }
  if (summary.nextSteps?.length) {
    lines.push('### Next route');
    for (const item of summary.nextSteps) lines.push(`- ${item}`);
    lines.push('');
  }
  lines.push(`_Summary saved at ${summary.createdAt}._`);
  return `${lines.join('\n')}\n`;
}

function renderEvidenceBrief(evidence = []) {
  if (!evidence.length) return '—';
  return compactOneLine(evidence[evidence.length - 1].summary || evidence[evidence.length - 1].kind || 'captured', 80);
}

function conciseEvidence(evidence = []) {
  const seen = new Set();
  const out = [];
  for (const item of evidence) {
    const value = compactOneLine(String(item || '').replace(/\s+/g, ' '), 180);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function taskIcon(status) {
  switch (status) {
    case 'done': return '✅ done';
    case 'active': return '▶ active';
    case 'blocked': return '⛔ blocked';
    case 'dropped': return '↘ dropped';
    case 'superseded': return '↪ superseded';
    default: return '○ pending';
  }
}

function omitEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function sanitizeEvidence(item = {}) {
  return omitEmpty({
    kind: item.kind,
    summary: item.summary,
    files: Array.isArray(item.files) && item.files.length ? item.files : undefined,
    command: item.command || undefined,
    exitCode: item.exitCode ?? undefined,
    notes: item.notes || undefined,
    at: item.at
  });
}

function deriveRenderedMode(lastUpdate) {
  switch (lastUpdate?.kind) {
    case 'run_started':
    case 'run_reconciled':
      return 'full';
    case 'turn_finalized':
      return 'final';
    case 'task_started':
    case 'task_completed':
    case 'task_blocked':
    case 'task_dropped':
    case 'task_superseded':
    case 'progress':
      return 'delta';
    case 'stop_audit':
      return 'gate';
    default:
      return 'full';
  }
}

function hashRenderState(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function lastCompletedTask(snapshot) {
  const done = (snapshot.tasks || []).filter((task) => task.status === 'done');
  return done[done.length - 1] || null;
}

function sortTasksForDisplay(tasks, currentTask) {
  return [...tasks].sort((a, b) => {
    const phase = displayPhaseRank(a, currentTask) - displayPhaseRank(b, currentTask);
    if (phase !== 0) return phase;
    const order = Number(a.sortOrder || 0) - Number(b.sortOrder || 0);
    if (order !== 0) return order;
    return String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id));
  });
}

function displayPhaseRank(task, currentTask) {
  if (task.status === 'done') return 10;
  if (currentTask && task.id === currentTask.id) return 20;
  if (task.status === 'active') return 20;
  if (task.status === 'blocked') return 30;
  if (task.status === 'pending') return 40;
  if (task.status === 'dropped' || task.status === 'superseded') return 90;
  return 50;
}

function derivePhase(tasks) {
  if (!tasks.length) return 'idle';
  if (tasks.some((task) => task.status === 'active')) return 'execution';
  if (tasks.every((task) => ['done', 'dropped', 'superseded'].includes(task.status))) return 'complete';
  if (tasks.some((task) => task.status === 'blocked')) return 'blocked';
  return 'planning';
}
