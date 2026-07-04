import path from 'node:path';
import { createStore } from '../storage/store.mjs';
import { assertCondition, OtmError } from './errors.mjs';
import { newId, nowIso, sha256, stableTaskKey, shortHash } from './ids.mjs';
import { findWorkspaceRoot, workspaceStateDir, ensureDir, summariesDir, atomicWriteJson, atomicWriteText, currentJsonPath, currentMarkdownPath, removeFileIfExists } from './fs-utils.mjs';
import { buildSnapshot, renderSnapshotMarkdown, renderSummaryMarkdown, renderDeltaMarkdown, writeCurrentFiles } from './renderer.mjs';
import { deriveFallbackTasks } from './planner.mjs';
import { CURRENT_SCHEMA_VERSION, MANAGER_NAME, TASK_STATUSES } from './constants.mjs';

export function createTaskManager(options = {}) {
  const env = options.env || process.env;
  const store = options.store || createStore({ env });

  function resolveWorkspace(cwdOrRoot) {
    return path.resolve(cwdOrRoot || options.cwd || process.cwd());
  }

  function recordEvent(runId, eventType, payload = {}, context = {}) {
    const event = {
      id: newId('evt'),
      runId,
      turnId: context.turnId || payload.turnId || null,
      hookEventName: context.hookEventName || payload.hookEventName || null,
      eventType,
      idempotencyKey: context.idempotencyKey || `${runId}:${eventType}:${shortHash(JSON.stringify(payload))}:${Date.now()}`,
      payload,
      createdAt: nowIso()
    };
    store.recordEvent(event);
    return event;
  }

  function getRunOrActive({ runId, workspaceRoot }) {
    if (runId) {
      const run = store.getRun(runId);
      assertCondition(run, `Run not found: ${runId}`, 'RUN_NOT_FOUND');
      return run;
    }
    const run = store.getActiveRun(workspaceRoot);
    assertCondition(run, 'No active Overtli Task Manager route exists for this workspace.', 'NO_ACTIVE_RUN');
    return run;
  }

  function normalizeTask(input, runId, sortOrder, createdBy = 'manual') {
    assertCondition(input && typeof input.title === 'string' && input.title.trim(), 'Task title is required.', 'INVALID_TASK');
    const acceptanceCriteria = Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length
      ? input.acceptanceCriteria.map(String).filter(Boolean)
      : ['Complete this route segment with concrete evidence.'];
    return {
      id: input.id || newId('task'),
      runId,
      parentId: input.parentId || null,
      stableKey: input.stableKey || stableTaskKey(input.title, acceptanceCriteria),
      title: input.title.trim(),
      description: input.description ? String(input.description).trim() : null,
      status: input.status && TASK_STATUSES.has(input.status) ? input.status : 'pending',
      required: input.required !== false,
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 50,
      sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : sortOrder,
      createdBy,
      acceptanceCriteria,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      metadata: input.metadata || {}
    };
  }

  function snapshotForRun(run, lastUpdate = null, { write = true } = {}) {
    const tasks = store.getTasks(run.id);
    const snapshot = buildSnapshot({ run, tasks, workspaceRoot: run.workspaceRoot, storageKind: store.kind, lastUpdate });
    if (write) writeCurrentFiles(run.workspaceRoot, snapshot);
    return snapshot;
  }

  function start(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    ensureDir(workspaceStateDir(workspaceRoot));
    const active = store.getActiveRun(workspaceRoot);
    if (active && args.replaceExisting !== true) {
      const snapshot = snapshotForRun(active, { kind: 'reuse_active', message: 'An active route already exists. Use reconcile to update it or pass replaceExisting=true to replace it.', at: nowIso() });
      return { run: active, snapshot, markdown: renderSnapshotMarkdown(snapshot), reused: true };
    }

    if (active && args.replaceExisting === true) {
      store.updateRun(active.id, { status: 'abandoned', finalizedAt: nowIso(), metadata: { ...(active.metadata || {}), abandonedReason: 'Replaced by new route' } });
      recordEvent(active.id, 'run_abandoned', { reason: 'Replaced by new route' }, args);
    }

    const prompt = String(args.prompt || args.goal || '').trim();
    const goal = String(args.goal || prompt || 'Complete the requested Codex task').trim();
    const createdAt = nowIso();
    const run = {
      id: args.runId || newId('run'),
      workspaceRoot,
      sessionId: args.sessionId || null,
      turnId: args.turnId || null,
      promptHash: sha256(prompt),
      goal,
      status: 'active',
      routeRevision: 1,
      currentTaskId: null,
      createdAt,
      updatedAt: createdAt,
      finalizedAt: null,
      metadata: {
        gitBranch: args.gitBranch || null,
        source: args.source || 'mcp',
        promptPreview: prompt.slice(0, 500)
      }
    };
    const taskInputs = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : deriveFallbackTasks(prompt, { goal });
    const tasks = taskInputs.map((task, index) => normalizeTask(task, run.id, index + 1, task.createdBy || 'prompt'));
    run.currentTaskId = tasks.find((task) => task.status === 'active')?.id || tasks[0]?.id || null;
    store.createRun(run);
    store.addTasks(tasks);
    recordEvent(run.id, 'run_started', { goal, taskCount: tasks.length, promptHash: run.promptHash }, args);
    const snapshot = snapshotForRun(run, { kind: 'run_started', message: `Route created with ${tasks.length} segment${tasks.length === 1 ? '' : 's'}.`, at: nowIso() });
    return { run, snapshot, markdown: renderSnapshotMarkdown(snapshot), reused: false };
  }

  function reconcile(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    let run = getRunOrActive({ runId: args.runId, workspaceRoot });
    const mode = args.mode || 'append';
    const now = nowIso();
    const tasks = store.getTasks(run.id);
    let changed = 0;

    if (mode === 'replace') {
      for (const task of tasks) {
        if (!['done', 'dropped', 'superseded'].includes(task.status)) {
          store.updateTask(task.id, { status: 'superseded', metadata: { ...(task.metadata || {}), supersededByPrompt: args.prompt || null } });
          changed += 1;
        }
      }
    }

    for (const change of Array.isArray(args.changes) ? args.changes : []) {
      if (change.action === 'supersede' || change.action === 'drop') {
        const task = store.getTask(change.taskId);
        if (task) {
          store.updateTask(task.id, { status: change.action === 'drop' ? 'dropped' : 'superseded', metadata: { ...(task.metadata || {}), reason: change.reason || args.prompt || null } });
          changed += 1;
        }
      } else if (change.action === 'activate') {
        markTaskActive({ runId: run.id, taskId: change.taskId, note: change.reason || 'Activated by reconciliation', silent: true });
        changed += 1;
      } else if (change.action === 'add') {
        const nextOrder = store.getTasks(run.id).length + 1;
        store.addTasks([normalizeTask(change, run.id, nextOrder, 'steering')]);
        changed += 1;
      }
    }

    if (Array.isArray(args.tasks) && args.tasks.length) {
      const existing = store.getTasks(run.id);
      const keys = new Set(existing.map((task) => task.stableKey));
      const additions = [];
      for (const [index, input] of args.tasks.entries()) {
        const task = normalizeTask(input, run.id, existing.length + index + 1, input.createdBy || 'steering');
        if (!keys.has(task.stableKey)) {
          keys.add(task.stableKey);
          additions.push(task);
        }
      }
      if (additions.length) {
        store.addTasks(additions);
        changed += additions.length;
      }
    }

    const refreshedTasks = store.getTasks(run.id);
    const current = refreshedTasks.find((task) => task.status === 'active') || refreshedTasks.find((task) => !['done', 'dropped', 'superseded'].includes(task.status));
    run = store.updateRun(run.id, {
      routeRevision: (run.routeRevision || 1) + (changed ? 1 : 0),
      currentTaskId: current?.id || null,
      status: refreshedTasks.some((task) => task.status === 'blocked') ? 'blocked' : 'active',
      updatedAt: now
    });
    recordEvent(run.id, 'run_reconciled', { mode, changed, prompt: args.prompt || null }, args);
    const snapshot = snapshotForRun(run, { kind: 'run_reconciled', message: changed ? `Route updated with ${changed} change${changed === 1 ? '' : 's'}.` : 'Route checked. No changes were needed.', at: now });
    return { run, snapshot, markdown: renderSnapshotMarkdown(snapshot), changed };
  }

  function markTaskActive(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    let run = getRunOrActive({ runId: args.runId, workspaceRoot });
    const task = store.getTask(args.taskId || run.currentTaskId);
    assertCondition(task && task.runId === run.id, 'Task not found in active route.', 'TASK_NOT_FOUND');
    assertCondition(!['done', 'dropped', 'superseded'].includes(task.status), `Cannot activate task in status ${task.status}.`, 'INVALID_TRANSITION');

    for (const other of store.getTasks(run.id)) {
      if (other.status === 'active' && other.id !== task.id) store.updateTask(other.id, { status: 'pending' });
    }
    store.updateTask(task.id, { status: 'active' });
    run = store.updateRun(run.id, { currentTaskId: task.id, status: 'active' });
    recordEvent(run.id, 'task_started', { taskId: task.id, title: task.title, note: args.note || null }, args);
    const snapshot = snapshotForRun(run, { kind: 'task_started', message: `Working on: ${task.title}`, at: nowIso() });
    return args.silent ? { run, snapshot } : { run, snapshot, markdown: renderDeltaMarkdown(snapshot) };
  }

  function progress(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    let run = getRunOrActive({ runId: args.runId, workspaceRoot });
    if (args.taskId) {
      const task = store.getTask(args.taskId);
      assertCondition(task && task.runId === run.id, 'Task not found in active route.', 'TASK_NOT_FOUND');
      const evidence = [...(task.evidence || []), evidenceFromArgs(args.evidence || { kind: 'manual_note', summary: args.message || 'Progress recorded' })];
      store.updateTask(task.id, { evidence, status: task.status === 'pending' ? 'active' : task.status });
      run = store.updateRun(run.id, { currentTaskId: task.id, status: 'active' });
    }
    recordEvent(run.id, 'progress', { message: args.message || null, taskId: args.taskId || null }, args);
    const snapshot = snapshotForRun(run, { kind: 'progress', message: args.message || 'Progress checkpoint recorded.', at: nowIso() });
    return { run, snapshot, markdown: renderDeltaMarkdown(snapshot) };
  }

  function completeTask(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    let run = getRunOrActive({ runId: args.runId, workspaceRoot });
    const taskId = args.taskId || run.currentTaskId;
    const task = store.getTask(taskId);
    assertCondition(task && task.runId === run.id, 'Task not found in active route.', 'TASK_NOT_FOUND');
    const evidence = args.evidence ? evidenceFromArgs(args.evidence) : null;
    const nextEvidence = evidence ? [...(task.evidence || []), evidence] : (task.evidence || []);
    assertCondition(args.force === true || nextEvidence.length > 0, 'A task can only be completed after evidence is attached.', 'EVIDENCE_REQUIRED');
    store.updateTask(task.id, { status: 'done', evidence: nextEvidence, completedAt: nowIso() });
    const next = store.getTasks(run.id).find((item) => item.required && !['done', 'dropped', 'superseded'].includes(item.status));
    run = store.updateRun(run.id, { currentTaskId: next?.id || null, status: next ? 'active' : 'active' });
    recordEvent(run.id, 'task_completed', { taskId: task.id, title: task.title, evidence }, args);
    const snapshot = snapshotForRun(run, { kind: 'task_completed', message: `Completed: ${task.title}`, at: nowIso() });
    return { run, snapshot, markdown: renderDeltaMarkdown(snapshot) };
  }

  function blockTask(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    let run = getRunOrActive({ runId: args.runId, workspaceRoot });
    const task = store.getTask(args.taskId || run.currentTaskId);
    assertCondition(task && task.runId === run.id, 'Task not found in active route.', 'TASK_NOT_FOUND');
    const evidence = evidenceFromArgs(args.evidence || { kind: 'blocker', summary: args.reason || 'Task blocked' });
    store.updateTask(task.id, {
      status: 'blocked',
      evidence: [...(task.evidence || []), evidence],
      metadata: { ...(task.metadata || {}), blockerRequiresUser: Boolean(args.requiresUser), blockerReason: args.reason || null }
    });
    run = store.updateRun(run.id, { currentTaskId: task.id, status: 'blocked' });
    recordEvent(run.id, 'task_blocked', { taskId: task.id, reason: args.reason || null, requiresUser: Boolean(args.requiresUser) }, args);
    const snapshot = snapshotForRun(run, { kind: 'task_blocked', message: `Blocked: ${task.title}${args.reason ? ` — ${args.reason}` : ''}`, at: nowIso() });
    return { run, snapshot, markdown: renderDeltaMarkdown(snapshot, { title: 'OTM Gate' }) };
  }

  function dropTask(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    let run = getRunOrActive({ runId: args.runId, workspaceRoot });
    const task = store.getTask(args.taskId);
    assertCondition(task && task.runId === run.id, 'Task not found in active route.', 'TASK_NOT_FOUND');
    store.updateTask(task.id, { status: args.supersede ? 'superseded' : 'dropped', metadata: { ...(task.metadata || {}), reason: args.reason || null } });
    const next = store.getTasks(run.id).find((item) => !['done', 'dropped', 'superseded'].includes(item.status));
    run = store.updateRun(run.id, { currentTaskId: next?.id || null, status: 'active', routeRevision: (run.routeRevision || 1) + 1 });
    recordEvent(run.id, args.supersede ? 'task_superseded' : 'task_dropped', { taskId: task.id, reason: args.reason || null }, args);
    const snapshot = snapshotForRun(run, { kind: args.supersede ? 'task_superseded' : 'task_dropped', message: `${args.supersede ? 'Superseded' : 'Dropped'}: ${task.title}`, at: nowIso() });
    return { run, snapshot, markdown: renderDeltaMarkdown(snapshot) };
  }

  function auditStop(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    const run = args.runId ? store.getRun(args.runId) : store.getActiveRun(workspaceRoot);
    if (!run) {
      const snapshot = clearedSnapshot(workspaceRoot, { message: 'No active route. Stop is allowed.' });
      return { stopAllowed: true, run: null, snapshot, markdown: renderSnapshotMarkdown(snapshot) };
    }
    const tasks = store.getTasks(run.id);
    const remainingRequired = tasks.filter((task) => task.required && !['done', 'dropped', 'superseded'].includes(task.status));
    const stopAllowed = remainingRequired.length === 0;
    const snapshot = snapshotForRun(run, { kind: 'stop_audit', message: stopAllowed ? 'Audit passed. All required route segments are complete.' : `Audit blocked. ${remainingRequired.length} required route segment${remainingRequired.length === 1 ? '' : 's'} remain.`, at: nowIso() });
    return {
      stopAllowed,
      run,
      remainingRequired: remainingRequired.map((task) => ({ id: task.id, title: task.title, status: task.status, required: task.required })),
      snapshot,
      markdown: renderSnapshotMarkdown(snapshot)
    };
  }

  function finalizeTurn(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    let run = getRunOrActive({ runId: args.runId, workspaceRoot });
    const audit = auditStop({ workspaceRoot, runId: run.id });
    if (!audit.stopAllowed && args.allowIncomplete !== true) {
      throw new OtmError('Cannot finalize while required route segments remain open.', { code: 'STOP_AUDIT_FAILED', details: audit.remainingRequired });
    }
    const tasks = store.getTasks(run.id);
    const summaryJson = buildSummaryJson({ run, tasks, outcome: args.outcome || (audit.stopAllowed ? 'completed' : 'incomplete'), nextSteps: args.nextSteps || [] });
    const summaryMd = renderSummaryMarkdown(summaryJson);
    const summaryId = args.summaryId || newId('summary');
    const createdAt = nowIso();
    const turnId = args.turnId || run.turnId || 'manual';
    const summary = { id: summaryId, runId: run.id, workspaceRoot, turnId, summaryMd, summaryJson, currentCleared: false, createdAt };
    store.upsertSummary(summary);
    ensureDir(summariesDir(workspaceRoot));
    const base = path.join(summariesDir(workspaceRoot), `${turnId}-${summaryId}`);
    atomicWriteJson(`${base}.json`, summaryJson);
    atomicWriteText(`${base}.md`, summaryMd);
    upsertMemory({ workspaceRoot, kind: 'turn_summary', title: `Turn summary: ${run.goal}`, body: summaryMd, tags: ['turn-summary', 'checkpoint'], source: { runId: run.id, summaryId, turnId } });
    run = store.updateRun(run.id, { status: audit.stopAllowed ? 'completed' : 'blocked', finalizedAt: createdAt });
    recordEvent(run.id, 'turn_finalized', { summaryId, complete: audit.stopAllowed }, args);
    const snapshot = snapshotForRun(run, { kind: 'turn_finalized', message: 'Turn summary written. Active route can now be cleared.', at: createdAt });
    if (args.clear === true || args.clearCurrent === true) {
      const cleared = clearCurrent({ workspaceRoot, runId: run.id, deleteFiles: Boolean(args.deleteFiles) });
      return { run, summary, summaryJson, summaryMd, snapshot: cleared.snapshot || snapshot, cleared, markdown: `${summaryMd}
${cleared.markdown || ''}` };
    }
    return { run, summary, summaryJson, summaryMd, snapshot, markdown: summaryMd };
  }

  function clearCurrent(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    const run = args.runId ? store.getRun(args.runId) : store.getActiveRun(workspaceRoot);
    if (run) {
      store.updateRun(run.id, { status: args.status || 'cleared', finalizedAt: run.finalizedAt || nowIso() });
      recordEvent(run.id, 'current_cleared', { mode: args.deleteFiles ? 'delete' : 'tombstone' }, args);
    }
    if (args.deleteFiles) {
      removeFileIfExists(currentJsonPath(workspaceRoot));
      removeFileIfExists(currentMarkdownPath(workspaceRoot));
      return { cleared: true, deleted: true, markdown: '## ✅ Overtli Task Manager\n\nActive route cleared.\n' };
    }
    const tombstone = clearedSnapshot(workspaceRoot, { message: 'Active route cleared after summary.' }, run?.id || null);
    writeCurrentFiles(workspaceRoot, tombstone);
    return { cleared: true, deleted: false, snapshot: tombstone, markdown: renderSnapshotMarkdown(tombstone) };
  }

  function snapshot(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    const run = args.runId ? store.getRun(args.runId) : store.getActiveRun(workspaceRoot);
    if (!run) {
      const empty = clearedSnapshot(workspaceRoot, { message: 'No active route.' });
      if (args.write !== false) writeCurrentFiles(workspaceRoot, empty);
      return { run: null, snapshot: empty, markdown: renderSnapshotMarkdown(empty) };
    }
    const snap = snapshotForRun(run, args.lastUpdate || null, { write: args.write !== false });
    return { run, snapshot: snap, markdown: renderSnapshotMarkdown(snap) };
  }

  function upsertMemory(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    const now = nowIso();
    const id = args.id || `mem_${shortHash(`${workspaceRoot}:${args.kind}:${args.title}`)}`;
    const entry = {
      id,
      workspaceRoot,
      kind: args.kind || 'note',
      title: String(args.title || 'Project memory').trim(),
      body: String(args.body || '').trim(),
      tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
      source: args.source || {},
      scoreHint: Number(args.scoreHint || 0),
      createdAt: args.createdAt || now,
      updatedAt: now,
      expiresAt: args.expiresAt || null
    };
    assertCondition(entry.body, 'Memory body is required.', 'INVALID_MEMORY');
    store.upsertCache(entry);
    return { entry };
  }

  function searchMemory(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    const query = String(args.query || '').trim();
    const entries = store.listCache(workspaceRoot, Number(args.limit || 50));
    const scored = entries.map((entry) => ({ entry, score: scoreEntry(entry, query) }))
      .filter((item) => !query || item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(args.limit || 10));
    return { entries: scored.map(({ entry, score }) => ({ ...entry, score })) };
  }

  function deleteMemory(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    return { deleted: store.deleteCache({ ...args, workspaceRoot }) };
  }

  function listRuns(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    return { runs: store.listRuns(workspaceRoot, Number(args.limit || 20)) };
  }

  return {
    store,
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
    snapshot,
    upsertMemory,
    searchMemory,
    deleteMemory,
    listRuns,
    recordEvent
  };
}

function evidenceFromArgs(input = {}) {
  return omitEmpty({
    kind: input.kind || 'manual_note',
    summary: String(input.summary || input.message || 'Evidence captured').trim(),
    files: Array.isArray(input.files) && input.files.length ? input.files.map(String) : undefined,
    command: input.command || undefined,
    exitCode: input.exitCode ?? undefined,
    notes: input.notes || undefined,
    at: nowIso()
  });
}

function buildSummaryJson({ run, tasks, outcome, nextSteps }) {
  const completed = tasks.filter((task) => task.status === 'done').map((task) => task.title);
  const blocked = tasks.filter((task) => task.status === 'blocked').map((task) => task.title);
  const dropped = tasks.filter((task) => ['dropped', 'superseded'].includes(task.status)).map((task) => task.title);
  const evidence = tasks.flatMap((task) => (task.evidence || []).map((item) => `${task.title}: ${item.summary || item.kind}`));
  return omitEmpty({
    schemaVersion: 'otm.summary.v1',
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
    createdAt: nowIso()
  });
}

function clearedSnapshot(workspaceRoot, lastUpdate = null, lastRunId = null) {
  return omitEmpty({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    manager: MANAGER_NAME,
    status: 'cleared',
    lastRunId: lastRunId || undefined,
    workspaceRoot,
    goal: 'No active route',
    routeRevision: 0,
    phase: 'idle',
    stopAllowed: true,
    stopReason: 'No active route.',
    progress: { requiredDone: 0, requiredTotal: 0, optionalDone: 0, optionalTotal: 0, percentRequired: 100 },
    checklist: [],
    tasks: [],
    lastUpdate: lastUpdate || undefined,
    storage: { kind: 'unknown' },
    paths: {
      currentJson: '.codex/overtli-task-manager/current.json',
      currentMarkdown: '.codex/overtli-task-manager/current.md'
    },
    updatedAt: nowIso()
  });
}

function omitEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function scoreEntry(entry, query) {
  if (!query) return entry.scoreHint || 0;
  const q = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${entry.title}
${entry.body}
${(entry.tags || []).join(' ')}`.toLowerCase();
  let hits = 0;
  for (const part of q) if (hay.includes(part)) hits += 1;
  return hits + (entry.scoreHint || 0);
}
