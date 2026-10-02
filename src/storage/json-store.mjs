import fs from "node:fs";
import path from "node:path";
import { ensureDir, atomicWriteJson } from "../core/fs-utils.mjs";
import { OtmError } from "../core/errors.mjs";
import { nowIso } from "../core/ids.mjs";

export class JsonStore {
  constructor({ stateDir, readOnly = false }) {
    this.kind = "json";
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, "state.json");
    this.lockPath = path.join(stateDir, "state.lock");
    this.readOnly = readOnly;
    if (!readOnly) ensureDir(stateDir);
  }

  init() {
    // Opening an existing JSON store is a validation-only read. Rewriting it
    // here would make status/doctor/export commands mutate durable state and
    // would constantly rotate recovery backups without a real mutation.
    if (fs.existsSync(this.filePath) || this.readOnly) {
      this.#read();
      return;
    }
    this.#withLock(() => {
      if (!fs.existsSync(this.filePath)) this.#write(this.#empty());
      else this.#read();
    });
  }

  #empty() {
    return {
      schemaVersion: "otm.store.v1",
      runs: [],
      sessionBindings: [],
      tasks: [],
      events: [],
      summaries: [],
      cache: [],
    };
  }

  #read() {
    if (!fs.existsSync(this.filePath)) return this.#empty();
    try {
      return parseStateDocument(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      // A read-only open is diagnostic only. It must preserve bytes, mtime,
      // directory entries, and locks even when corruption is discovered.
      if (this.readOnly)
        throw error?.code === "JSON_STORE_CORRUPTION"
          ? error
          : new OtmError("Unable to read JSON store.", {
              code: "JSON_STORE_READ_FAILED",
              cause: error,
            });
      if (error?.code === "JSON_STORE_CORRUPTION")
        throw this.#quarantine(error);
      throw new OtmError("Unable to read JSON store without modifying it.", {
        code: "JSON_STORE_READ_FAILED",
        cause: error,
      });
    }
  }

  #quarantine(_cause) {
    const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
    let preserved = false;
    try {
      fs.renameSync(this.filePath, quarantinePath);
      preserved = true;
    } catch {}
    return new OtmError(
      "JSON store is corrupted and was quarantined. Restore a backup or repair the preserved state before retrying.",
      {
        code: "JSON_STORE_CORRUPTION",
        details: {
          quarantinePath: preserved ? quarantinePath : null,
          preserved,
          recovery: `${this.filePath}.backup`,
        },
      },
    );
  }

  #write(data) {
    if (this.readOnly)
      throw new OtmError("Store was opened read-only.", {
        code: "STORE_READ_ONLY",
      });
    validateStateDocument(data);
    // Keep a last-known-good rotating recovery copy.  The current state is
    // never replaced until both the in-memory document and backup are valid.
    if (fs.existsSync(this.filePath)) {
      const backupPath = `${this.filePath}.backup`;
      try {
        fs.copyFileSync(this.filePath, backupPath);
      } catch (_error) {
        throw new OtmError("Unable to create JSON store recovery backup.", {
          code: "JSON_STORE_BACKUP_FAILED",
          details: { backupPath },
        });
      }
    }
    atomicWriteJson(this.filePath, data);
  }

  transaction(fn) {
    if (this.readOnly)
      throw new OtmError("Store was opened read-only.", {
        code: "STORE_READ_ONLY",
      });
    return this.#withLock(() => {
      const data = this.#read();
      const result = fn(data);
      this.#write(data);
      return result;
    });
  }

  #withLock(fn) {
    const deadline = Date.now() + 5_000;
    while (true) {
      let handle = null;
      try {
        handle = fs.openSync(this.lockPath, "wx");
        fs.writeFileSync(
          handle,
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
            operation: "store-transaction",
            heartbeatAt: new Date().toISOString(),
          }),
          "utf8",
        );
        return fn();
      } catch (error) {
        // Windows can report EPERM for a moment while another process owns or
        // removes a lock file. Treat it as contention only when the lock is
        // actually present; unrelated permission failures still surface.
        if (
          error?.code !== "EEXIST" &&
          !(error?.code === "EPERM" && fs.existsSync(this.lockPath))
        )
          throw error;
        const stat = statSafe(this.lockPath);
        const owner = readLockOwner(this.lockPath);
        // Age alone is never authority to steal a lock.  A live process may
        // legitimately be doing migration, recovery, or a large transaction.
        if (
          stat &&
          Date.now() - stat.mtimeMs > 30_000 &&
          !isProcessAlive(owner?.pid)
        ) {
          try {
            fs.rmSync(this.lockPath, { force: true });
          } catch {}
          continue;
        }
        if (Date.now() >= deadline)
          throw new Error(
            `Timed out waiting for OTM JSON store lock: ${this.lockPath}`,
          );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } finally {
        if (handle !== null) {
          try {
            fs.closeSync(handle);
          } catch {}
          try {
            fs.rmSync(this.lockPath, { force: true });
          } catch {}
        }
      }
    }
  }

  close() {}

  createRun(run) {
    return this.transaction((data) => {
      data.runs.push(run);
      return run;
    });
  }

  /** Atomically create a scoped route, its complete initial checklist, and event. */
  createRoute({
    run,
    tasks,
    event,
    replaceRunId = null,
    sessionBinding = null,
  }) {
    return this.transaction((data) => {
      let currentBinding = null;
      if (sessionBinding) {
        currentBinding = data.sessionBindings.find(
          (item) => item.rootSessionId === sessionBinding.rootSessionId,
        );
        if (
          currentBinding &&
          sessionBinding.expectedRunId !== undefined &&
          currentBinding.currentRunId !== sessionBinding.expectedRunId
        )
          throw new OtmError(
            "Canonical session binding changed before route creation.",
            { code: "CANONICAL_ROUTE_CONFLICT" },
          );
        if (
          currentBinding?.currentRunId &&
          currentBinding.currentRunId !== run.id &&
          currentBinding.currentRunId !== replaceRunId
        ) {
          const prior = data.runs.find(
            (item) => item.id === currentBinding.currentRunId,
          );
          if (
            prior &&
            ["active", "ready_to_finalize", "blocked", "paused"].includes(
              prior.status,
            )
          )
            throw new OtmError(
              "An active canonical route already exists for this Codex session.",
              {
                code: "CANONICAL_ROUTE_CONFLICT",
                details: { runId: prior.id },
              },
            );
        }
        const canonicalPrior = data.runs.find(
          (item) => item.id === currentBinding?.currentRunId,
        );
        const rotating =
          !canonicalPrior ||
          !["active", "ready_to_finalize", "blocked", "paused"].includes(
            canonicalPrior.status,
          ) ||
          replaceRunId === canonicalPrior.id;
        if (rotating) {
          for (const prior of data.runs) {
            if (
              prior.id === canonicalPrior?.id ||
              prior.id === replaceRunId ||
              prior.sessionId !== run.sessionId ||
              !["active", "ready_to_finalize", "blocked", "paused"].includes(
                prior.status,
              )
            )
              continue;
            prior.status = "abandoned";
            prior.finalizedAt = run.createdAt;
            prior.updatedAt = run.createdAt;
            prior.metadata = {
              ...(prior.metadata || {}),
              canonicalSupersededAtRunId: run.id,
              canonicalSupersededReason:
                "A new route rotated the root-session binding; legacy route evidence was retained.",
            };
          }
        }
      }
      const active = data.runs.find(
        (item) =>
          item.workspaceRoot === run.workspaceRoot &&
          (item.sessionId || null) === (run.sessionId || null) &&
          ["active", "ready_to_finalize", "blocked", "paused"].includes(
            item.status,
          ),
      );
      if (active && active.id !== replaceRunId) {
        throw new OtmError(
          "An active route already exists for this workspace and session.",
          {
            code: "ACTIVE_ROUTE_CONFLICT",
            details: { runId: active.id, routeRevision: active.routeRevision },
          },
        );
      }
      if (replaceRunId) {
        const prior = data.runs.find((item) => item.id === replaceRunId);
        if (!prior)
          throw new OtmError(
            "Route selected for replacement no longer exists.",
            { code: "RUN_NOT_FOUND" },
          );
        prior.status = "abandoned";
        prior.finalizedAt = run.createdAt;
        prior.updatedAt = run.createdAt;
        prior.metadata = {
          ...(prior.metadata || {}),
          abandonedReason: "Replaced by new route",
        };
      }
      data.runs.push(run);
      data.tasks.push(...tasks);
      if (
        !data.events.some(
          (item) => item.idempotencyKey === event.idempotencyKey,
        )
      )
        data.events.push(event);
      if (sessionBinding) {
        const index = data.sessionBindings.findIndex(
          (item) => item.rootSessionId === sessionBinding.rootSessionId,
        );
        const nextBinding = normalizeSessionBinding({
          ...sessionBinding,
          currentRunId: run.id,
          primaryWorkspace: run.workspaceRoot,
          status: "bound",
          updatedAt: run.createdAt,
          expectedRunId: undefined,
        });
        if (index >= 0) data.sessionBindings[index] = nextBinding;
        else data.sessionBindings.push(nextBinding);
      }
      return run;
    });
  }

  /** Atomically apply a run revision, one or more full task records, and an event. */
  commitRunMutation({
    run,
    expectedRevision,
    tasks = [],
    newTasks = [],
    summaries = [],
    event = null,
  }) {
    return this.transaction((data) => {
      const runIndex = data.runs.findIndex((item) => item.id === run.id);
      if (runIndex < 0)
        throw new OtmError("Run not found.", { code: "RUN_NOT_FOUND" });
      const current = data.runs[runIndex];
      if (
        expectedRevision !== undefined &&
        Number(current.routeRevision) !== Number(expectedRevision)
      ) {
        throw new OtmError("Route revision conflict.", {
          code: "REVISION_CONFLICT",
          details: {
            expectedRevision,
            currentRevision: current.routeRevision,
            runId: run.id,
          },
        });
      }
      for (const task of tasks) {
        const index = data.tasks.findIndex(
          (item) => item.id === task.id && item.runId === run.id,
        );
        if (index < 0)
          throw new OtmError("Task not found in run.", {
            code: "TASK_NOT_FOUND",
            details: { taskId: task.id, runId: run.id },
          });
        data.tasks[index] = { ...task, updatedAt: task.updatedAt || nowIso() };
      }
      for (const task of newTasks) {
        if (
          task.runId !== run.id ||
          data.tasks.some((item) => item.id === task.id)
        ) {
          throw new OtmError("New task is invalid for this run.", {
            code: "TASK_NOT_FOUND",
            details: { taskId: task.id, runId: run.id },
          });
        }
        data.tasks.push({ ...task, updatedAt: task.updatedAt || nowIso() });
      }
      for (const summary of summaries) {
        const index = data.summaries.findIndex(
          (item) => item.id === summary.id,
        );
        if (index >= 0) data.summaries[index] = summary;
        else data.summaries.push(summary);
      }
      data.runs[runIndex] = { ...run, updatedAt: run.updatedAt || nowIso() };
      if (
        event &&
        !data.events.some(
          (item) => item.idempotencyKey === event.idempotencyKey,
        )
      )
        data.events.push(event);
      return data.runs[runIndex];
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

  getCanonicalBinding(rootSessionId) {
    return (
      this.#read().sessionBindings.find(
        (item) => item.rootSessionId === rootSessionId,
      ) || null
    );
  }

  listRunsBySession(sessionId) {
    return this.#read()
      .runs.filter((run) => run.sessionId === sessionId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  ensureCanonicalBinding(binding) {
    return this.transaction((data) => {
      const existing = data.sessionBindings.find(
        (item) => item.rootSessionId === binding.rootSessionId,
      );
      if (existing) return existing;
      const normalized = normalizeSessionBinding(binding);
      data.sessionBindings.push(normalized);
      return normalized;
    });
  }

  /** @param {{ expectedRunId?: string | null }} [options] */
  updateCanonicalBinding(binding, options = {}) {
    const { expectedRunId } = options;
    return this.transaction((data) => {
      const index = data.sessionBindings.findIndex(
        (item) => item.rootSessionId === binding.rootSessionId,
      );
      const current = index < 0 ? null : data.sessionBindings[index];
      if (
        expectedRunId !== undefined &&
        (current?.currentRunId || null) !== expectedRunId
      ) {
        throw new OtmError(
          "Canonical session binding changed during resolution.",
          { code: "CANONICAL_ROUTE_CONFLICT" },
        );
      }
      const normalized = normalizeSessionBinding({
        ...current,
        ...binding,
        updatedAt: binding.updatedAt || nowIso(),
      });
      if (index >= 0) data.sessionBindings[index] = normalized;
      else data.sessionBindings.push(normalized);
      return normalized;
    });
  }

  getActiveRun(workspaceRoot, sessionId) {
    const scoped = arguments.length >= 2;
    const runs = this.#read()
      .runs.filter(
        (run) =>
          run.workspaceRoot === workspaceRoot &&
          (!scoped || (run.sessionId || null) === (sessionId || null)) &&
          ["active", "ready_to_finalize", "blocked", "paused"].includes(
            run.status,
          ),
      )
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return runs[0] || null;
  }

  listActiveRuns(workspaceRoot) {
    return this.#read()
      .runs.filter(
        (run) =>
          run.workspaceRoot === workspaceRoot &&
          ["active", "ready_to_finalize", "blocked", "paused"].includes(
            run.status,
          ),
      )
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /**
   * @param {{ expectedRunId?: string | null, resolution?: object }} [options]
   */
  addCanonicalWorkspaceAlias(rootSessionId, workspaceRoot, options = {}) {
    const { expectedRunId, resolution } = options;
    return this.transaction((data) => {
      const binding = data.sessionBindings.find(
        (item) => item.rootSessionId === rootSessionId,
      );
      if (!binding) return null;
      if (expectedRunId !== undefined && binding.currentRunId !== expectedRunId)
        throw new OtmError(
          "Canonical session binding changed while recording a workspace alias.",
          { code: "CANONICAL_ROUTE_CONFLICT" },
        );
      const aliases = [...(binding.workspaceAliases || [])];
      if (!aliases.some((item) => sameWorkspaceAlias(item, workspaceRoot)))
        aliases.push(workspaceRoot);
      const next = normalizeSessionBinding({
        ...binding,
        workspaceAliases: aliases,
        lastResolution: resolution || binding.lastResolution || null,
        updatedAt: nowIso(),
      });
      Object.assign(binding, next);
      return binding;
    });
  }

  claimLegacyActiveRun(workspaceRoot, sessionId, metadata = {}) {
    return this.transaction((data) => {
      const run = data.runs
        .filter(
          (item) =>
            item.workspaceRoot === workspaceRoot &&
            !item.sessionId &&
            ["active", "ready_to_finalize", "blocked", "paused"].includes(
              item.status,
            ),
        )
        .sort((a, b) =>
          String(b.updatedAt).localeCompare(String(a.updatedAt)),
        )[0];
      if (!run) return null;
      run.sessionId = sessionId;
      run.metadata = { ...(run.metadata || {}), ...metadata };
      run.updatedAt = nowIso();
      return run;
    });
  }

  listRuns(workspaceRoot, limit = 20) {
    return this.#read()
      .runs.filter(
        (run) => !workspaceRoot || run.workspaceRoot === workspaceRoot,
      )
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  }

  exportWorkspace(workspaceRoot) {
    const data = this.#read();
    const runs = data.runs.filter((run) => run.workspaceRoot === workspaceRoot);
    const runIds = new Set(runs.map((run) => run.id));
    return {
      runs,
      tasks: data.tasks.filter((task) => runIds.has(task.runId)),
      events: data.events.filter((event) => runIds.has(event.runId)),
      summaries: data.summaries.filter((summary) => runIds.has(summary.runId)),
      cache: data.cache.filter(
        (entry) => entry.workspaceRoot === workspaceRoot,
      ),
    };
  }

  importWorkspace(payload) {
    return this.transaction((data) => {
      assertImportDoesNotConflict(data, payload);
      data.runs.push(...payload.runs);
      data.tasks.push(...payload.tasks);
      data.events.push(...payload.events);
      data.summaries.push(...payload.summaries);
      data.cache.push(...payload.cache);
      return importCounts(payload);
    });
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
    return this.#read()
      .tasks.filter((task) => task.runId === runId)
      .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
  }

  recordEvent(event) {
    return this.transaction((data) => {
      if (
        !data.events.some(
          (item) => item.idempotencyKey === event.idempotencyKey,
        )
      ) {
        data.events.push(event);
      }
      return event;
    });
  }

  getEvents(runId, limit = 100) {
    return this.#read()
      .events.filter((event) => event.runId === runId)
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
    return this.#read()
      .summaries.filter(
        (summary) => !workspaceRoot || summary.workspaceRoot === workspaceRoot,
      )
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  listSummariesForRun(runId) {
    return this.#read()
      .summaries.filter((summary) => summary.runId === runId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  upsertCache(entry) {
    return this.transaction((data) => {
      const index = data.cache.findIndex((item) => item.id === entry.id);
      const next = {
        ...entry,
        createdAt: index >= 0 ? data.cache[index].createdAt : entry.createdAt,
      };
      if (index >= 0) data.cache[index] = next;
      else data.cache.push(next);
      return next;
    });
  }

  deleteCache(filter = {}) {
    if (
      !filter.id &&
      !filter.workspaceRoot &&
      !filter.kind &&
      !filter.tag &&
      !filter.expired
    ) {
      throw new OtmError("Cache deletion requires at least one selector.", {
        code: "CACHE_SELECTOR_REQUIRED",
      });
    }
    return this.transaction((data) => {
      const before = data.cache.length;
      data.cache = data.cache.filter((entry) => {
        if (filter.id && entry.id !== filter.id) return true;
        if (
          filter.workspaceRoot &&
          entry.workspaceRoot !== filter.workspaceRoot
        )
          return true;
        if (filter.kind && entry.kind !== filter.kind) return true;
        if (
          filter.tag &&
          !(entry.tags || [])
            .map((tag) => String(tag).trim().toLowerCase())
            .includes(String(filter.tag).trim().toLowerCase())
        )
          return true;
        if (
          filter.expired &&
          (!entry.expiresAt ||
            String(entry.expiresAt) > String(filter.now || nowIso()))
        )
          return true;
        return false;
      });
      return before - data.cache.length;
    });
  }

  listCache(workspaceRoot, limit = 100) {
    return this.#read()
      .cache.filter(
        (entry) => !workspaceRoot || entry.workspaceRoot === workspaceRoot,
      )
      .sort((a, b) =>
        String(b.updatedAt || b.createdAt).localeCompare(
          String(a.updatedAt || a.createdAt),
        ),
      )
      .slice(0, limit);
  }

  pruneHistory(options = {}) {
    const workspaceRoot = options.workspaceRoot || null;
    const olderThan = options.olderThan;
    const now = options.now || nowIso();
    const dryRun = options.dryRun === true;
    if (!olderThan)
      throw new Error("olderThan is required for history pruning");

    const evaluate = (data, mutate) => {
      const removableRunIds = new Set(
        data.runs
          .filter(
            (run) =>
              (!workspaceRoot || run.workspaceRoot === workspaceRoot) &&
              !["active", "ready_to_finalize", "blocked", "paused"].includes(
                run.status,
              ) &&
              String(run.finalizedAt || run.updatedAt || run.createdAt) <
                olderThan,
          )
          .map((run) => run.id),
      );
      const isOldCache = (entry) =>
        (!workspaceRoot || entry.workspaceRoot === workspaceRoot) &&
        ((entry.expiresAt && String(entry.expiresAt) <= now) ||
          String(entry.updatedAt || entry.createdAt) < olderThan);
      const deleted = {
        runs: removableRunIds.size,
        tasks: data.tasks.filter((task) => removableRunIds.has(task.runId))
          .length,
        events: data.events.filter((event) => removableRunIds.has(event.runId))
          .length,
        summaries: data.summaries.filter((summary) =>
          removableRunIds.has(summary.runId),
        ).length,
        cacheEntries: data.cache.filter(isOldCache).length,
      };
      if (mutate) {
        data.runs = data.runs.filter((run) => !removableRunIds.has(run.id));
        data.tasks = data.tasks.filter(
          (task) => !removableRunIds.has(task.runId),
        );
        data.events = data.events.filter(
          (event) => !removableRunIds.has(event.runId),
        );
        data.summaries = data.summaries.filter(
          (summary) => !removableRunIds.has(summary.runId),
        );
        for (const binding of data.sessionBindings) {
          if (removableRunIds.has(binding.currentRunId)) {
            binding.currentRunId = null;
            binding.status = "empty";
            binding.primaryWorkspace = null;
            binding.updatedAt = now;
          }
        }
        data.cache = data.cache.filter((entry) => !isOldCache(entry));
      }
      return {
        dryRun,
        workspaceRoot,
        olderThan,
        retentionDays: options.retentionDays,
        deleted,
      };
    };
    // A dry run must not obtain a write lock or rewrite/rotate JSON state.
    if (dryRun) return evaluate(this.#read(), false);
    return this.transaction((data) => evaluate(data, true));
  }
}

export function parseStateDocument(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw new OtmError("JSON store contains malformed JSON.", {
      code: "JSON_STORE_CORRUPTION",
      cause,
    });
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new OtmError("JSON store document is invalid.", {
      code: "JSON_STORE_CORRUPTION",
    });
  const normalized = {
    schemaVersion: data.schemaVersion || "otm.store.v1",
    runs: data.runs,
    sessionBindings: Array.isArray(data.sessionBindings)
      ? data.sessionBindings
      : [],
    tasks: data.tasks,
    events: data.events,
    summaries: data.summaries,
    cache: data.cache,
  };
  try {
    validateStateDocument(normalized);
  } catch (cause) {
    throw new OtmError("JSON store document is invalid.", {
      code: "JSON_STORE_CORRUPTION",
      cause,
    });
  }
  return normalized;
}

function validateStateDocument(data) {
  const collections = [
    "runs",
    "sessionBindings",
    "tasks",
    "events",
    "summaries",
    "cache",
  ];
  for (const name of collections) {
    if (!Array.isArray(data[name]))
      throw new OtmError("JSON store document has an invalid collection.", {
        code: "JSON_STORE_CORRUPTION",
        details: { collection: name },
      });
    const ids = new Set();
    for (const item of data[name]) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !item.id
      ) {
        throw new OtmError("JSON store document has an invalid record.", {
          code: "JSON_STORE_CORRUPTION",
          details: { collection: name },
        });
      }
      if (ids.has(item.id))
        throw new OtmError(
          "JSON store document contains duplicate identifiers.",
          {
            code: "JSON_STORE_CORRUPTION",
            details: { collection: name, id: item.id },
          },
        );
      ids.add(item.id);
    }
  }
  for (const binding of data.sessionBindings) {
    if (
      typeof binding.rootSessionId !== "string" ||
      binding.id !== binding.rootSessionId ||
      !Array.isArray(binding.workspaceAliases) ||
      !["empty", "bound", "needs_attention"].includes(binding.status)
    )
      throw new OtmError(
        "JSON store has an invalid canonical session binding.",
        {
          code: "JSON_STORE_CORRUPTION",
          details: { collection: "sessionBindings", id: binding.id },
        },
      );
  }
  const runIds = new Set(data.runs.map((run) => run.id));
  for (const [name, records] of [
    ["tasks", data.tasks],
    ["events", data.events],
    ["summaries", data.summaries],
  ]) {
    for (const record of records) {
      if (!runIds.has(record.runId))
        throw new OtmError("JSON store document has an orphaned record.", {
          code: "JSON_STORE_CORRUPTION",
          details: { collection: name, id: record.id, runId: record.runId },
        });
    }
  }
}

function normalizeSessionBinding(input = {}) {
  const rootSessionId = String(input.rootSessionId || input.id || "").trim();
  if (!rootSessionId)
    throw new OtmError("Canonical session binding needs a root session id.", {
      code: "INVALID_SESSION_BINDING",
    });
  const workspaceAliases = [];
  for (const value of Array.isArray(input.workspaceAliases)
    ? input.workspaceAliases
    : []) {
    const workspace = String(value || "").trim();
    if (
      workspace &&
      !workspaceAliases.some((item) => sameWorkspaceAlias(item, workspace))
    )
      workspaceAliases.push(workspace);
  }
  if (workspaceAliases.length > 64)
    throw new OtmError(
      "Canonical session binding has too many workspace aliases.",
      {
        code: "INPUT_TOO_LARGE",
      },
    );
  const status = input.status || (input.currentRunId ? "bound" : "empty");
  if (!["empty", "bound", "needs_attention"].includes(status))
    throw new OtmError("Canonical session binding status is invalid.", {
      code: "INVALID_SESSION_BINDING",
    });
  return {
    id: rootSessionId,
    rootSessionId,
    currentRunId: input.currentRunId || null,
    primaryWorkspace: input.primaryWorkspace || null,
    workspaceAliases,
    status,
    attention: input.attention || null,
    lastResolution: input.lastResolution || null,
    updatedAt: input.updatedAt || nowIso(),
  };
}

function sameWorkspaceAlias(left, right) {
  const a = String(left || "").replace(/[\\/]+$/, "");
  const b = String(right || "").replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function assertImportDoesNotConflict(data, payload) {
  for (const name of ["runs", "tasks", "events", "summaries", "cache"]) {
    const currentIds = new Set(data[name].map((item) => item.id));
    const duplicate = payload[name].find((item) => currentIds.has(item.id));
    if (duplicate)
      throw new OtmError(
        "Historical import conflicts with an existing record.",
        {
          code: "IMPORT_CONFLICT",
          details: { collection: name, id: duplicate.id },
        },
      );
  }
  const currentEventKeys = new Set(
    data.events.map((event) => event.idempotencyKey),
  );
  const duplicateEvent = payload.events.find((event) =>
    currentEventKeys.has(event.idempotencyKey),
  );
  if (duplicateEvent)
    throw new OtmError(
      "Historical import conflicts with an existing event idempotency key.",
      {
        code: "IMPORT_CONFLICT",
        details: {
          collection: "events",
          idempotencyKey: duplicateEvent.idempotencyKey,
        },
      },
    );
}

function importCounts(payload) {
  return Object.fromEntries(
    ["runs", "tasks", "events", "summaries", "cache"].map((name) => [
      name,
      payload[name].length,
    ]),
  );
}

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readLockOwner(filePath) {
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
