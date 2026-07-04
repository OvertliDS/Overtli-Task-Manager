import path from 'node:path';
import { ensureDir, readJson, atomicWriteJson } from '../core/fs-utils.mjs';
import { nowIso } from '../core/ids.mjs';

export class JsonStore {
  constructor({ stateDir }) {
    this.kind = 'json';
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, 'state.json');
    ensureDir(stateDir);
  }

  init() {
    this.#write(this.#read());
  }

  #empty() {
    return { schemaVersion: 'otm.store.v1', runs: [], tasks: [], events: [], summaries: [], cache: [] };
  }

  #read() {
    const data = readJson(this.filePath, null);
    if (!data || typeof data !== 'object') return this.#empty();
    return {
      schemaVersion: data.schemaVersion || 'otm.store.v1',
      runs: Array.isArray(data.runs) ? data.runs : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      events: Array.isArray(data.events) ? data.events : [],
      summaries: Array.isArray(data.summaries) ? data.summaries : [],
      cache: Array.isArray(data.cache) ? data.cache : []
    };
  }

  #write(data) {
    atomicWriteJson(this.filePath, data);
  }

  transaction(fn) {
    const data = this.#read();
    const result = fn(data);
    this.#write(data);
    return result;
  }

  createRun(run) {
    return this.transaction((data) => {
      data.runs.push(run);
      return run;
    });
  }

  updateRun(id, patch) {
    return this.transaction((data) => {
      const run = data.runs.find((item) => item.id === id);
      if (!run) return null;
      Object.assign(run, patch, { updatedAt: patch.updatedAt || nowIso() });
      return run;
    });
  }

  getRun(id) {
    return this.#read().runs.find((item) => item.id === id) || null;
  }

  getActiveRun(workspaceRoot) {
    const runs = this.#read().runs
      .filter((run) => run.workspaceRoot === workspaceRoot && ['active', 'blocked', 'paused'].includes(run.status))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return runs[0] || null;
  }

  listRuns(workspaceRoot, limit = 20) {
    return this.#read().runs
      .filter((run) => !workspaceRoot || run.workspaceRoot === workspaceRoot)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  }

  addTasks(tasks) {
    return this.transaction((data) => {
      for (const task of tasks) data.tasks.push(task);
      return tasks;
    });
  }

  updateTask(id, patch) {
    return this.transaction((data) => {
      const task = data.tasks.find((item) => item.id === id);
      if (!task) return null;
      Object.assign(task, patch, { updatedAt: patch.updatedAt || nowIso() });
      return task;
    });
  }

  getTask(id) {
    return this.#read().tasks.find((item) => item.id === id) || null;
  }

  getTasks(runId) {
    return this.#read().tasks
      .filter((task) => task.runId === runId)
      .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
  }

  recordEvent(event) {
    return this.transaction((data) => {
      if (!data.events.some((item) => item.idempotencyKey === event.idempotencyKey)) {
        data.events.push(event);
      }
      return event;
    });
  }

  getEvents(runId, limit = 100) {
    return this.#read().events
      .filter((event) => event.runId === runId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(-limit);
  }

  upsertSummary(summary) {
    return this.transaction((data) => {
      const index = data.summaries.findIndex((item) => item.id === summary.id);
      if (index >= 0) data.summaries[index] = summary;
      else data.summaries.push(summary);
      return summary;
    });
  }

  listSummaries(workspaceRoot, limit = 20) {
    return this.#read().summaries
      .filter((summary) => !workspaceRoot || summary.workspaceRoot === workspaceRoot)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  upsertCache(entry) {
    return this.transaction((data) => {
      const index = data.cache.findIndex((item) => item.id === entry.id);
      if (index >= 0) data.cache[index] = entry;
      else data.cache.push(entry);
      return entry;
    });
  }

  deleteCache(filter = {}) {
    return this.transaction((data) => {
      const before = data.cache.length;
      data.cache = data.cache.filter((entry) => {
        if (filter.id && entry.id !== filter.id) return true;
        if (filter.workspaceRoot && entry.workspaceRoot !== filter.workspaceRoot) return true;
        if (filter.kind && entry.kind !== filter.kind) return true;
        if (filter.tag && !(entry.tags || []).includes(filter.tag)) return true;
        return false;
      });
      return before - data.cache.length;
    });
  }

  listCache(workspaceRoot, limit = 100) {
    return this.#read().cache
      .filter((entry) => !workspaceRoot || entry.workspaceRoot === workspaceRoot)
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
      .slice(0, limit);
  }

  pruneHistory(options = {}) {
    const workspaceRoot = options.workspaceRoot || null;
    const olderThan = options.olderThan;
    const now = options.now || nowIso();
    const dryRun = options.dryRun === true;
    if (!olderThan) throw new Error('olderThan is required for history pruning');

    return this.transaction((data) => {
      const removableRunIds = new Set(data.runs
        .filter((run) => (!workspaceRoot || run.workspaceRoot === workspaceRoot)
          && !['active', 'blocked', 'paused'].includes(run.status)
          && String(run.finalizedAt || run.updatedAt || run.createdAt) < olderThan)
        .map((run) => run.id));
      const isOldCache = (entry) => (!workspaceRoot || entry.workspaceRoot === workspaceRoot)
        && ((entry.expiresAt && String(entry.expiresAt) <= now) || String(entry.updatedAt || entry.createdAt) < olderThan);
      const deleted = {
        runs: removableRunIds.size,
        tasks: data.tasks.filter((task) => removableRunIds.has(task.runId)).length,
        events: data.events.filter((event) => removableRunIds.has(event.runId)).length,
        summaries: data.summaries.filter((summary) => removableRunIds.has(summary.runId)).length,
        cacheEntries: data.cache.filter(isOldCache).length
      };
      if (!dryRun) {
        data.runs = data.runs.filter((run) => !removableRunIds.has(run.id));
        data.tasks = data.tasks.filter((task) => !removableRunIds.has(task.runId));
        data.events = data.events.filter((event) => !removableRunIds.has(event.runId));
        data.summaries = data.summaries.filter((summary) => !removableRunIds.has(summary.runId));
        data.cache = data.cache.filter((entry) => !isOldCache(entry));
      }
      return {
        dryRun,
        workspaceRoot,
        olderThan,
        retentionDays: options.retentionDays,
        deleted
      };
    });
  }
}
