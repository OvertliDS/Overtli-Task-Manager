import path from 'node:path';
import { createStore } from '../storage/store.mjs';
import { assertCondition, OtmError } from './errors.mjs';
import { newId, nowIso, sha256, stableTaskKey, shortHash } from './ids.mjs';
import { cleanupWorkspaceStateTempFiles, findWorkspaceRoot, workspaceStateDir, ensureDir, summariesDir, atomicWriteJson, atomicWriteText, currentJsonPath, currentMarkdownPath, removeFileIfExists, workspaceTempDir } from './fs-utils.mjs';
import { buildSnapshot, renderSnapshotMarkdown, renderSummaryMarkdown, renderDeltaMarkdown, writeCurrentFiles } from './renderer.mjs';
import { combinePromptContext, deriveFallbackTasks } from './planner.mjs';
import { CURRENT_SCHEMA_VERSION, MANAGER_NAME, TASK_STATUSES } from './constants.mjs';

const DEFAULT_HISTORY_RETENTION_DAYS = 7;

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
    const metadata = normalizeTaskMetadata(input, acceptanceCriteria);
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
      metadata
    };
  }

  function addOrMergeTask(input, run, sortOrder, createdBy = 'steering', reason = 'reconcile') {
    const task = normalizeTask(input, run.id, sortOrder, createdBy);
    if (input.reopen === true) {
      const closed = findRelatedReopenableTask(store.getTasks(run.id), task);
      if (closed) {
        reopenTask(closed, task, reason);
        return { action: 'reopened', taskId: closed.id };
      }
    }
    const match = findRelatedOpenTask(store.getTasks(run.id), task);
    if (match) {
      mergeTask(match, task, reason);
      return { action: 'merged', taskId: match.id };
    }
    store.addTasks([task]);
    return { action: 'added', taskId: task.id };
  }

  function mergeTask(existing, incoming, reason) {
    const existingMetadata = existing.metadata || {};
    const incomingMetadata = incoming.metadata || {};
    const metadata = { ...incomingMetadata, ...existingMetadata };
    const internalSteps = mergeInternalSteps(existingMetadata.internalSteps || [], incomingMetadata.internalSteps || []);
    if (internalSteps.length) metadata.internalSteps = internalSteps;
    metadata.consolidatedFrom = [
      ...(Array.isArray(existingMetadata.consolidatedFrom) ? existingMetadata.consolidatedFrom : []),
      omitEmpty({
        id: incoming.id,
        title: incoming.title,
        stableKey: incoming.stableKey,
        reason,
        at: nowIso()
      })
    ];
    store.updateTask(existing.id, {
      required: Boolean(existing.required || incoming.required),
      priority: Math.min(Number(existing.priority || 50), Number(incoming.priority || 50)),
      acceptanceCriteria: unionStrings(existing.acceptanceCriteria || [], incoming.acceptanceCriteria || []),
      metadata
    });
  }

  function reopenTask(existing, incoming = null, reason = 'reconcile') {
    const existingMetadata = existing.metadata || {};
    const incomingMetadata = incoming?.metadata || {};
    const metadata = { ...incomingMetadata, ...existingMetadata };
    const internalSteps = resetInternalStepsForReopen(mergeInternalSteps(existingMetadata.internalSteps || [], incomingMetadata.internalSteps || []));
    if (internalSteps.length) metadata.internalSteps = internalSteps;
    metadata.reopened = [
      ...(Array.isArray(existingMetadata.reopened) ? existingMetadata.reopened : []),
      omitEmpty({
        previousStatus: existing.status,
        previousCompletedAt: existing.completedAt || undefined,
        reason,
        at: nowIso()
      })
    ];
    store.updateTask(existing.id, {
      status: incoming?.status === 'active' ? 'active' : 'pending',
      completedAt: null,
      required: incoming ? Boolean(existing.required || incoming.required) : existing.required,
      priority: incoming ? Math.min(Number(existing.priority || 50), Number(incoming.priority || 50)) : existing.priority,
      acceptanceCriteria: incoming ? unionStrings(existing.acceptanceCriteria || [], incoming.acceptanceCriteria || []) : existing.acceptanceCriteria,
      metadata
    });
  }

  function activateCurrentTask(runId, current) {
    for (const task of store.getTasks(runId)) {
      if (task.status === 'active' && task.id !== current?.id) store.updateTask(task.id, { status: 'pending' });
    }
    if (current) {
      store.updateTask(current.id, {
        status: current.status === 'pending' ? 'active' : current.status,
        metadata: ensureInternalStepProgress(current.metadata, current.status === 'pending' ? 'active' : current.status)
      });
    }
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
    const plannerPrompt = combinePromptContext(prompt, {
      context: args.context,
      promptContext: args.promptContext,
      attachments: args.attachments,
      screenshots: args.screenshots || args.images
    }).trim() || prompt;
    const goal = String(args.goal || prompt || 'Complete the requested Codex task').trim();
    const createdAt = nowIso();
    const run = {
      id: args.runId || newId('run'),
      workspaceRoot,
      sessionId: args.sessionId || null,
      turnId: args.turnId || null,
      promptHash: sha256(plannerPrompt),
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
        promptPreview: plannerPrompt.slice(0, 500)
      }
    };
    const taskInputs = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : deriveFallbackTasks(prompt, {
      goal,
      context: args.context,
      promptContext: args.promptContext,
      attachments: args.attachments,
      screenshots: args.screenshots || args.images
    });
    const tasks = taskInputs.map((task, index) => normalizeTask(task, run.id, index + 1, task.createdBy || 'prompt'));
    normalizeActiveTasks(tasks);
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
    let preferredCurrentId = run.currentTaskId;
    let forcePreferredCurrent = false;

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
        preferredCurrentId = change.taskId;
        forcePreferredCurrent = true;
        changed += 1;
      } else if (change.action === 'reopen') {
        const task = resolveTaskForReopen(change, store.getTasks(run.id));
        if (task) {
          reopenTask(task, change.title ? normalizeTask(change, run.id, task.sortOrder, 'steering') : null, change.reason || args.prompt || 'change:reopen');
          preferredCurrentId = task.id;
          forcePreferredCurrent = true;
          changed += 1;
        }
      } else if (change.action === 'add') {
        const nextOrder = store.getTasks(run.id).length + 1;
        addOrMergeTask(change, run, nextOrder, 'steering', change.reason || args.prompt || 'change:add');
        changed += 1;
      }
    }

    if (Array.isArray(args.tasks) && args.tasks.length) {
      for (const [index, input] of args.tasks.entries()) {
        const nextOrder = store.getTasks(run.id).length + index + 1;
        addOrMergeTask(input, run, nextOrder, input.createdBy || 'steering', args.prompt || 'reconcile:tasks');
        changed += 1;
      }
    }

    const refreshedTasks = store.getTasks(run.id);
    const current = chooseCurrentTask(refreshedTasks, preferredCurrentId, { forcePreferred: forcePreferredCurrent });
    activateCurrentTask(run.id, current);
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
    assertCanSwitchTask(store.getTasks(run.id), task, args);

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
    const targetTaskId = args.taskId || (hasInternalStepUpdate(args) ? run.currentTaskId : null);
    if (targetTaskId) {
      const task = store.getTask(targetTaskId);
      assertCondition(task && task.runId === run.id, 'Task not found in active route.', 'TASK_NOT_FOUND');
      assertCanSwitchTask(store.getTasks(run.id), task, args);
      const evidence = [...(task.evidence || []), evidenceFromArgs(args.evidence || { kind: 'manual_note', summary: args.message || 'Progress recorded' })];
      const status = task.status === 'pending' ? 'active' : task.status;
      const metadata = updateInternalStepProgress(task.metadata, args, { taskStatus: status });
      store.updateTask(task.id, { evidence, status, metadata });
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
    assertCondition(args.force === true || evidence, 'A task can only be completed after completion evidence is attached.', 'EVIDENCE_REQUIRED');
    assertInternalStepsComplete(task.metadata);
    store.updateTask(task.id, { status: 'done', evidence: nextEvidence, completedAt: nowIso(), metadata: normalizeCompletedInternalSteps(task.metadata) });
    const next = chooseCurrentTask(store.getTasks(run.id), task.id);
    activateCurrentTask(run.id, next);
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
    const tempDir = workspaceTempDir(workspaceRoot);
    atomicWriteJson(`${base}.json`, summaryJson, { tempDir });
    atomicWriteText(`${base}.md`, summaryMd, { tempDir });
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
      cleanupWorkspaceStateTempFiles(workspaceRoot, { minAgeMs: 0, scratchMaxAgeMs: 0 });
      pruneHistoryQuietly(workspaceRoot);
      return { cleared: true, deleted: true, markdown: '## ✅ Overtli Task Manager\n\nActive route cleared.\n' };
    }
    const tombstone = clearedSnapshot(workspaceRoot, { message: 'Active route cleared after summary.' }, run?.id || null);
    writeCurrentFiles(workspaceRoot, tombstone);
    cleanupWorkspaceStateTempFiles(workspaceRoot, { minAgeMs: 0, scratchMaxAgeMs: 0 });
    pruneHistoryQuietly(workspaceRoot);
    return { cleared: true, deleted: false, snapshot: tombstone, markdown: renderSnapshotMarkdown(tombstone) };
  }

  function cleanupWorkspace(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    const removed = cleanupWorkspaceStateTempFiles(workspaceRoot, {
      minAgeMs: args.minAgeMs ?? 0,
      scratchMaxAgeMs: args.scratchMaxAgeMs ?? 0
    });
    const lines = ['## ✅ OTM cleanup', '', `Workspace: \`${workspaceRoot}\``, `Removed artifact(s): ${removed.length}`];
    return { workspaceRoot, removed, markdown: `${lines.join('\n')}\n` };
  }

  function pruneHistory(args = {}) {
    const workspaceRoot = resolveWorkspace(args.workspaceRoot || findWorkspaceRoot(args.cwd));
    assertCondition(typeof store.pruneHistory === 'function', 'Current OTM store does not support history pruning.', 'PRUNE_UNSUPPORTED');
    const retentionDays = normalizeRetentionDays(args.retentionDays);
    const olderThan = args.olderThan || retentionCutoffIso(retentionDays, args.now);
    const result = store.pruneHistory({
      workspaceRoot,
      retentionDays,
      olderThan,
      now: args.now || nowIso(),
      dryRun: args.dryRun === true
    });
    return { ...result, markdown: renderPruneHistoryMarkdown(result) };
  }

  function pruneHistoryQuietly(workspaceRoot) {
    try {
      if (typeof store.pruneHistory !== 'function') return null;
      return pruneHistory({ workspaceRoot });
    } catch {
      return null;
    }
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
    cleanupWorkspace,
    pruneHistory,
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

function normalizeRetentionDays(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_HISTORY_RETENTION_DAYS;
  const days = Number(value);
  assertCondition(Number.isFinite(days) && days >= 0, 'retentionDays must be a non-negative number.', 'INVALID_RETENTION');
  return days;
}

function retentionCutoffIso(retentionDays, now = null) {
  const base = now ? new Date(now) : new Date();
  assertCondition(!Number.isNaN(base.getTime()), 'now must be a valid date/time.', 'INVALID_RETENTION');
  return new Date(base.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

function renderPruneHistoryMarkdown(result = {}) {
  const deleted = result.deleted || {};
  const total = Object.values(deleted).reduce((sum, value) => sum + Number(value || 0), 0);
  const lines = [
    `## ${result.dryRun ? '🧪' : '✅'} OTM history cleanup`,
    '',
    `Workspace: \`${result.workspaceRoot || 'all workspaces'}\``,
    `Retention: ${result.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS} day(s)`,
    `Cutoff: \`${result.olderThan}\``,
    `Mode: ${result.dryRun ? 'dry run' : 'deleted'}`,
    '',
    '| Table | Rows |',
    '|---|---:|',
    `| runs | ${deleted.runs || 0} |`,
    `| tasks | ${deleted.tasks || 0} |`,
    `| events | ${deleted.events || 0} |`,
    `| summaries | ${deleted.summaries || 0} |`,
    `| cache_entries | ${deleted.cacheEntries || 0} |`,
    `| total | ${total} |`
  ];
  return `${lines.join('\n')}\n`;
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

function normalizeTaskMetadata(input, acceptanceCriteria) {
  const metadata = { ...(input.metadata || {}) };
  const internalSteps = normalizeInternalSteps(input, acceptanceCriteria);
  if (internalSteps.length) metadata.internalSteps = internalSteps;
  return metadata;
}

function normalizeActiveTasks(tasks) {
  const active = tasks.find((task) => task.status === 'active') || tasks[0] || null;
  for (const task of tasks) {
    if (task.id === active?.id && task.status === 'pending') task.status = 'active';
    else if (task.id !== active?.id && task.status === 'active') task.status = 'pending';
    task.metadata = ensureInternalStepProgress(task.metadata, task.status);
  }
}

function normalizeInternalSteps(input, acceptanceCriteria = []) {
  const supplied = Array.isArray(input.internalSteps) ? input.internalSteps : input.metadata?.internalSteps;
  const explicit = Array.isArray(supplied) ? normalizeInternalStepList(supplied) : [];
  if (explicit.length) return explicit;

  const criteriaSteps = unionStrings(acceptanceCriteria)
    .filter((item) => item !== 'Complete this route segment with concrete evidence.');
  if (criteriaSteps.length) return normalizeInternalStepList(criteriaSteps);

  const title = String(input.title || 'route segment').trim();
  return normalizeInternalStepList([
    `Clarify scope for ${title}`,
    `Implement or inspect the required change for ${title}`,
    `Run relevant checks for ${title}`,
    `Record evidence for ${title}`
  ]);
}

function normalizeInternalStepList(steps = []) {
  const seen = new Set();
  const normalized = [];
  for (const [index, item] of steps.entries()) {
    const raw = typeof item === 'object' && item !== null ? item : { title: item };
    const title = String(raw.title || raw.text || raw.summary || raw.name || '').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const status = normalizeInternalStepStatus(raw.status);
    normalized.push(omitEmpty({
      id: raw.id ? String(raw.id) : `step_${shortHash(`${title}:${index}`)}`,
      title,
      status,
      kind: raw.kind ? String(raw.kind) : undefined,
      source: raw.source ? String(raw.source) : undefined,
      updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
      completedAt: raw.completedAt ? String(raw.completedAt) : undefined
    }));
  }
  return normalized;
}

function normalizeInternalStepStatus(status) {
  const value = String(status || 'pending').toLowerCase();
  if (value === 'complete' || value === 'completed') return 'done';
  if (['pending', 'active', 'done', 'blocked', 'skipped'].includes(value)) return value;
  return 'pending';
}

function mergeInternalSteps(existing = [], incoming = []) {
  const merged = normalizeInternalStepList(existing);
  const byTitle = new Map(merged.map((step, index) => [step.title.toLowerCase(), index]));
  for (const step of normalizeInternalStepList(incoming)) {
    const key = step.title.toLowerCase();
    const existingIndex = byTitle.get(key);
    if (existingIndex === undefined) {
      byTitle.set(key, merged.length);
      merged.push(step);
    } else {
      merged[existingIndex] = { ...step, ...merged[existingIndex], status: merged[existingIndex].status || step.status || 'pending' };
    }
  }
  return merged;
}

function resetInternalStepsForReopen(steps = []) {
  return normalizeInternalStepList(steps).map((step, index) => omitEmpty({
    ...step,
    status: index === 0 ? 'active' : 'pending',
    reopenedAt: nowIso(),
    completedAt: undefined
  }));
}

function ensureInternalStepProgress(metadata = {}, taskStatus = 'pending') {
  const internalSteps = normalizeInternalStepList(metadata.internalSteps || []);
  if (!internalSteps.length) return metadata || {};
  if (taskStatus === 'done') return { ...metadata, internalSteps: internalSteps.map((step) => markInternalStep(step, 'done')) };
  if (taskStatus === 'active' && !internalSteps.some((step) => step.status === 'active')) {
    const index = internalSteps.findIndex((step) => step.status === 'pending');
    if (index >= 0) internalSteps[index] = markInternalStep(internalSteps[index], 'active');
  }
  return { ...metadata, internalSteps };
}

function hasInternalStepUpdate(args = {}) {
  return args.internalStep !== undefined || args.internalStepId !== undefined || args.internalStepTitle !== undefined || args.internalStepIndex !== undefined || args.internalStepStatus !== undefined;
}

function updateInternalStepProgress(metadata = {}, args = {}, options = {}) {
  let internalSteps = normalizeInternalStepList(metadata.internalSteps || []);
  if (!internalSteps.length) return metadata || {};
  if (!hasInternalStepUpdate(args)) return ensureInternalStepProgress({ ...metadata, internalSteps }, options.taskStatus || 'active');

  const request = normalizeInternalStepRequest(args);
  let index = findInternalStepIndex(internalSteps, request);
  if (index < 0 && request.title) {
    internalSteps.push({ id: `step_${shortHash(`${request.title}:${internalSteps.length}`)}`, title: request.title, status: 'pending' });
    index = internalSteps.length - 1;
  }
  if (index < 0) return ensureInternalStepProgress({ ...metadata, internalSteps }, options.taskStatus || 'active');

  const nextStatus = request.status || 'done';
  if (nextStatus === 'active') internalSteps = internalSteps.map((step, stepIndex) => step.status === 'active' && stepIndex !== index ? markInternalStep(step, 'pending') : step);
  internalSteps[index] = markInternalStep(internalSteps[index], nextStatus);
  if (nextStatus === 'done' && request.advance !== false) {
    const nextIndex = internalSteps.findIndex((step, stepIndex) => stepIndex > index && step.status === 'pending');
    if (nextIndex >= 0) internalSteps[nextIndex] = markInternalStep(internalSteps[nextIndex], 'active');
  }
  return { ...metadata, internalSteps };
}

function normalizeInternalStepRequest(args = {}) {
  const raw = typeof args.internalStep === 'object' && args.internalStep !== null ? args.internalStep : {};
  const title = typeof args.internalStep === 'string'
    ? args.internalStep
    : raw.title || raw.text || raw.summary || args.internalStepTitle || null;
  return omitEmpty({
    id: raw.id || args.internalStepId,
    title: title ? String(title).trim() : undefined,
    index: Number.isInteger(raw.index) ? raw.index : (Number.isInteger(args.internalStepIndex) ? args.internalStepIndex : undefined),
    status: normalizeInternalStepStatus(raw.status || args.internalStepStatus || 'done'),
    advance: raw.advance ?? args.advanceInternalStep
  });
}

function findInternalStepIndex(steps, request) {
  if (request.id) {
    const idIndex = steps.findIndex((step) => step.id === request.id);
    if (idIndex >= 0) return idIndex;
  }
  if (Number.isInteger(request.index) && request.index >= 0 && request.index < steps.length) return request.index;
  if (request.title) {
    const key = request.title.toLowerCase();
    return steps.findIndex((step) => step.title.toLowerCase() === key);
  }
  return -1;
}

function markInternalStep(step, status) {
  return omitEmpty({
    ...step,
    status: normalizeInternalStepStatus(status),
    updatedAt: nowIso(),
    completedAt: normalizeInternalStepStatus(status) === 'done' ? (step.completedAt || nowIso()) : step.completedAt
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
  const incomplete = internalSteps.filter((step) => !['done', 'skipped'].includes(step.status));
  assertCondition(
    incomplete.length === 0,
    `Complete all internal steps before completing this route segment: ${incomplete.map((step) => step.title).join('; ')}`,
    'INTERNAL_STEPS_INCOMPLETE',
    { incompleteInternalSteps: incomplete }
  );
}

function findRelatedOpenTask(tasks, candidate) {
  const open = tasks.filter((task) => !['done', 'dropped', 'superseded'].includes(task.status));
  return open.find((task) => task.stableKey === candidate.stableKey)
    || open.find((task) => relatedTaskScore(task, candidate) >= 0.72)
    || null;
}

function findRelatedReopenableTask(tasks, candidate) {
  const reopenable = tasks.filter((task) => ['done', 'dropped', 'superseded', 'blocked'].includes(task.status));
  return reopenable.find((task) => task.stableKey === candidate.stableKey)
    || reopenable.find((task) => relatedTaskScore(task, candidate) >= 0.72)
    || null;
}

function chooseCurrentTask(tasks, previousCurrentId = null, options = {}) {
  const open = tasks.filter((task) => task.required && !['done', 'dropped', 'superseded'].includes(task.status));
  if (!open.length) return null;
  const previous = open.find((task) => task.id === previousCurrentId);
  if (options.forcePreferred && previous) return previous;
  const active = open.find((task) => task.status === 'active');
  if (active) return active;
  if (previous) return previous;
  return [...open].sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))[0];
}

function assertCanSwitchTask(tasks, targetTask, args = {}) {
  if (args.allowSwitch === true || args.silent === true) return;
  const active = tasks.find((task) => task.status === 'active' && task.required);
  assertCondition(
    !active || active.id === targetTask.id,
    `Complete or explicitly reconcile the active task before moving on: ${active?.title}`,
    'ACTIVE_TASK_INCOMPLETE'
  );
}

function resolveTaskForReopen(change, tasks) {
  if (change.taskId) return tasks.find((task) => task.id === change.taskId) || null;
  if (change.stableKey) return tasks.find((task) => task.stableKey === change.stableKey) || null;
  if (change.title) {
    const candidate = {
      stableKey: change.stableKey || stableTaskKey(change.title, Array.isArray(change.acceptanceCriteria) ? change.acceptanceCriteria : []),
      title: change.title
    };
    return findRelatedReopenableTask(tasks, candidate);
  }
  return null;
}

function relatedTaskScore(a, b) {
  const left = taskTokens(a.title);
  const right = taskTokens(b.title);
  if (left.size < 2 || right.size < 2) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  if (overlap < 2) return 0;
  return overlap / Math.min(left.size, right.size);
}

function taskTokens(title) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'route', 'task', 'tasks', 'segment', 'segments', 'work']);
  const words = String(title || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return new Set(words
    .map((word) => word.replace(/ing$/, '').replace(/ed$/, '').replace(/s$/, ''))
    .filter((word) => word.length > 2 && !stop.has(word)));
}

function unionStrings(...groups) {
  const seen = new Set();
  const values = [];
  for (const group of groups.flat()) {
    const value = String(group || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
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
