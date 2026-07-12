import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ensureDir } from '../core/fs-utils.mjs';
import { nowIso } from '../core/ids.mjs';
import { OtmError } from '../core/errors.mjs';

const require = createRequire(import.meta.url);
/**
 * Schema versions are deliberately independent of the package version.  Do
 * not fold a migration into CREATE TABLE: existing installations must take an
 * ordered, observable upgrade path.
 */
export const SQLITE_SCHEMA_VERSION = 3;

export function loadBetterSqlite3() {
  try {
    return require('better-sqlite3');
  } catch {
    return null;
  }
}

export class SqliteStore {
  constructor({ stateDir, readOnly = false }) {
    const BetterSqlite3 = loadBetterSqlite3();
    if (!BetterSqlite3) throw new Error('better-sqlite3 is not installed');
    this.kind = 'sqlite';
    this.stateDir = stateDir;
    this.readOnly = readOnly;
    if (!readOnly) ensureDir(stateDir);
    this.dbPath = path.join(stateDir, 'state.sqlite');
    this.db = readOnly
      ? new BetterSqlite3(this.dbPath, { readonly: true, fileMustExist: true })
      : new BetterSqlite3(this.dbPath);
    if (!readOnly) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
  }

  init() {
    const currentVersion = Number(this.db.pragma('user_version', { simple: true }) || 0);
    if (this.readOnly) {
      if (currentVersion > SQLITE_SCHEMA_VERSION) throw new Error(`SQLite store schema ${currentVersion} is newer than supported schema ${SQLITE_SCHEMA_VERSION}.`);
      return;
    }
    if (currentVersion > SQLITE_SCHEMA_VERSION) throw new Error(`SQLite store schema ${currentVersion} is newer than supported schema ${SQLITE_SCHEMA_VERSION}.`);
    if (currentVersion < SQLITE_SCHEMA_VERSION && fs.existsSync(this.dbPath)) this.#backupBeforeMigration(currentVersion);
    this.db.transaction(() => {
      if (currentVersion === 0) this.#createV1Schema();
      // Some early development builds marked a partial schema as v1/v2.
      // Preserve their existing rows while filling missing canonical tables
      // before index/trigger migrations reference them.
      if (currentVersion > 0 && currentVersion < SQLITE_SCHEMA_VERSION) this.#createV1Schema();
      if (currentVersion < 2) this.#migrateV1ToV2();
      if (currentVersion < 3) this.#migrateV2ToV3();
      this.db.pragma(`user_version = ${SQLITE_SCHEMA_VERSION}`);
    })();
  }

  #backupBeforeMigration(fromVersion) {
    const backupPath = `${this.dbPath}.pre-migration-v${fromVersion}-${Date.now()}.bak`;
    // Checkpoint before the synchronous copy so a schema/data change in the
    // WAL is included in the recoverable database image.
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(this.dbPath, backupPath, fs.constants.COPYFILE_EXCL);
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
      throw new Error(`Unable to back up SQLite store before migration: ${backupPath}`);
    }
  }

  #createV1Schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        prompt_hash TEXT,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        route_revision INTEGER NOT NULL DEFAULT 1,
        current_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finalized_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_id TEXT,
        stable_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 50,
        sort_order INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        turn_id TEXT,
        hook_event_name TEXT,
        event_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        turn_id TEXT,
        summary_md TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        current_cleared INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS cache_entries (
        id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        source_json TEXT NOT NULL DEFAULT '{}',
        score_hint REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_workspace_status ON runs(workspace_root, status);
      CREATE INDEX IF NOT EXISTS idx_runs_workspace_session_status ON runs(workspace_root, session_id, status);
      CREATE INDEX IF NOT EXISTS idx_runs_session_turn ON runs(session_id, turn_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_run_created ON events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cache_workspace_kind ON cache_entries(workspace_root, kind);
      CREATE INDEX IF NOT EXISTS idx_tasks_run_order_status ON tasks(run_id, sort_order, status);
      CREATE INDEX IF NOT EXISTS idx_summaries_run_workspace_date ON summaries(run_id, workspace_root, created_at);
      CREATE INDEX IF NOT EXISTS idx_cache_workspace_kind_expiry ON cache_entries(workspace_root, kind, expires_at);
    `);
  }

  #migrateV1ToV2() {
    // SQLite NULL values do not collide in ordinary unique indexes; IFNULL is
    // required to enforce the invariant for legacy unscoped runs as well.
    const duplicates = this.db.prepare(`SELECT workspace_root, IFNULL(session_id, '') AS session_key, COUNT(*) AS count
      FROM runs WHERE status IN ('active','ready_to_finalize','blocked','paused')
      GROUP BY workspace_root, IFNULL(session_id, '') HAVING COUNT(*) > 1`).all();
    if (duplicates.length) {
      throw new Error(`SQLite migration blocked: duplicate active route scopes detected (${duplicates.length}). Run otm doctor and explicitly resolve duplicate runs before retrying.`);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_one_active_scope
      ON runs(workspace_root, IFNULL(session_id, ''))
      WHERE status IN ('active','ready_to_finalize','blocked','paused');`);
  }

  #migrateV2ToV3() {
    // SQLite cannot add CHECK constraints to an existing table without a
    // destructive table rebuild. These aborting triggers provide the same
    // durable boundary for both migrated and fresh databases.
    const invalid = this.db.prepare(`
      SELECT 'runs' AS collection, id FROM runs WHERE status IS NULL OR status NOT IN ('active','ready_to_finalize','completed','blocked','paused','cleared','abandoned','archived')
      UNION ALL SELECT 'tasks', id FROM tasks WHERE status IS NULL OR status NOT IN ('pending','active','done','blocked','dropped','superseded') OR required IS NULL OR required NOT IN (0, 1)
      UNION ALL SELECT 'summaries', id FROM summaries WHERE current_cleared IS NULL OR current_cleared NOT IN (0, 1)
      LIMIT 10
    `).all();
    if (invalid.length) {
      throw new Error(`SQLite migration blocked: invalid status or boolean values found (${invalid.map((row) => `${row.collection}:${row.id}`).join(', ')}). Run otm doctor and restore or repair the database before retrying.`);
    }
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS otm_runs_status_insert
      BEFORE INSERT ON runs FOR EACH ROW WHEN NEW.status NOT IN ('active','ready_to_finalize','completed','blocked','paused','cleared','abandoned','archived')
      BEGIN SELECT RAISE(ABORT, 'OTM_INVALID_RUN_STATUS'); END;
      CREATE TRIGGER IF NOT EXISTS otm_runs_status_update
      BEFORE UPDATE OF status ON runs FOR EACH ROW WHEN NEW.status NOT IN ('active','ready_to_finalize','completed','blocked','paused','cleared','abandoned','archived')
      BEGIN SELECT RAISE(ABORT, 'OTM_INVALID_RUN_STATUS'); END;
      CREATE TRIGGER IF NOT EXISTS otm_tasks_status_insert
      BEFORE INSERT ON tasks FOR EACH ROW WHEN NEW.status NOT IN ('pending','active','done','blocked','dropped','superseded')
      BEGIN SELECT RAISE(ABORT, 'OTM_INVALID_TASK_STATUS'); END;
      CREATE TRIGGER IF NOT EXISTS otm_tasks_status_update
      BEFORE UPDATE OF status ON tasks FOR EACH ROW WHEN NEW.status NOT IN ('pending','active','done','blocked','dropped','superseded')
      BEGIN SELECT RAISE(ABORT, 'OTM_INVALID_TASK_STATUS'); END;
      CREATE TRIGGER IF NOT EXISTS otm_tasks_required_insert
      BEFORE INSERT ON tasks FOR EACH ROW WHEN NEW.required NOT IN (0, 1)
      BEGIN SELECT RAISE(ABORT, 'OTM_INVALID_TASK_REQUIRED'); END;
      CREATE TRIGGER IF NOT EXISTS otm_tasks_required_update
      BEFORE UPDATE OF required ON tasks FOR EACH ROW WHEN NEW.required NOT IN (0, 1)
      BEGIN SELECT RAISE(ABORT, 'OTM_INVALID_TASK_REQUIRED'); END;
      CREATE TRIGGER IF NOT EXISTS otm_summaries_cleared_insert
      BEFORE INSERT ON summaries FOR EACH ROW WHEN NEW.current_cleared NOT IN (0, 1)
      BEGIN SELECT RAISE(ABORT, 'OTM_INVALID_SUMMARY_CLEARED'); END;
      CREATE TRIGGER IF NOT EXISTS otm_summaries_cleared_update
      BEFORE UPDATE OF current_cleared ON summaries FOR EACH ROW WHEN NEW.current_cleared NOT IN (0, 1)
      BEGIN SELECT RAISE(ABORT, 'OTM_INVALID_SUMMARY_CLEARED'); END;
    `);
  }

  integrityCheck() { return this.db.pragma('integrity_check'); }

  close() { this.db.close(); }

  transaction(fn) {
    return this.db.transaction(() => fn())();
  }

  createRun(run) {
    this.db.prepare(`INSERT INTO runs (id, workspace_root, session_id, turn_id, prompt_hash, goal, status, route_revision, current_task_id, created_at, updated_at, finalized_at, metadata_json)
      VALUES (@id, @workspaceRoot, @sessionId, @turnId, @promptHash, @goal, @status, @routeRevision, @currentTaskId, @createdAt, @updatedAt, @finalizedAt, @metadataJson)`).run(toRunRow(run));
    return run;
  }

  /** Atomically create a scoped route, its complete initial checklist, and event. */
  createRoute({ run, tasks, event, replaceRunId = null }) {
    try {
      return this.transaction(() => {
        if (replaceRunId) {
          const prior = this.getRun(replaceRunId);
          if (!prior) throw new Error('RUN_NOT_FOUND');
          this.updateRun(replaceRunId, {
            status: 'abandoned', finalizedAt: run.createdAt, updatedAt: run.createdAt,
            metadata: { ...(prior.metadata || {}), abandonedReason: 'Replaced by new route' }
          });
        }
        this.createRun(run);
        const stmt = this.db.prepare(`INSERT INTO tasks (id, run_id, parent_id, stable_key, title, description, status, required, priority, sort_order, created_by, acceptance_criteria_json, evidence_json, created_at, updated_at, completed_at, metadata_json)
          VALUES (@id, @runId, @parentId, @stableKey, @title, @description, @status, @required, @priority, @sortOrder, @createdBy, @acceptanceCriteriaJson, @evidenceJson, @createdAt, @updatedAt, @completedAt, @metadataJson)`);
        for (const task of tasks) stmt.run(toTaskRow(task));
        this.recordEvent(event);
        return run;
      });
    } catch (error) {
      if (String(error?.message || '').includes('uq_runs_one_active_scope') || String(error?.message || '').includes('UNIQUE constraint failed')) {
        throw new OtmError('An active route already exists for this workspace and session.', { code: 'ACTIVE_ROUTE_CONFLICT' });
      }
      if (error?.message === 'RUN_NOT_FOUND') throw new OtmError('Route selected for replacement no longer exists.', { code: 'RUN_NOT_FOUND' });
      throw error;
    }
  }

  /** Atomically apply a run revision, one or more full task records, and an event. */
  commitRunMutation({ run, expectedRevision, tasks = [], newTasks = [], summaries = [], event = null }) {
    return this.transaction(() => {
      const current = this.getRun(run.id);
      if (!current) throw new OtmError('Run not found.', { code: 'RUN_NOT_FOUND' });
      if (expectedRevision !== undefined && Number(current.routeRevision) !== Number(expectedRevision)) {
        throw new OtmError('Route revision conflict.', { code: 'REVISION_CONFLICT', details: { expectedRevision, currentRevision: current.routeRevision, runId: run.id } });
      }
      for (const task of tasks) {
        if (task.runId !== run.id || !this.getTask(task.id)) throw new OtmError('Task not found in run.', { code: 'TASK_NOT_FOUND', details: { taskId: task.id, runId: run.id } });
        this.updateTask(task.id, task);
      }
      for (const task of newTasks) {
        if (task.runId !== run.id || this.getTask(task.id)) {
          throw new OtmError('New task is invalid for this run.', { code: 'TASK_NOT_FOUND', details: { taskId: task.id, runId: run.id } });
        }
        this.db.prepare(`INSERT INTO tasks (id, run_id, parent_id, stable_key, title, description, status, required, priority, sort_order, created_by, acceptance_criteria_json, evidence_json, created_at, updated_at, completed_at, metadata_json)
          VALUES (@id, @runId, @parentId, @stableKey, @title, @description, @status, @required, @priority, @sortOrder, @createdBy, @acceptanceCriteriaJson, @evidenceJson, @createdAt, @updatedAt, @completedAt, @metadataJson)`).run(toTaskRow(task));
      }
      for (const summary of summaries) this.upsertSummary(summary);
      const next = { ...run, updatedAt: run.updatedAt || nowIso() };
      const result = this.db.prepare(`UPDATE runs SET workspace_root=@workspaceRoot, session_id=@sessionId, turn_id=@turnId, prompt_hash=@promptHash, goal=@goal, status=@status, route_revision=@routeRevision, current_task_id=@currentTaskId, updated_at=@updatedAt, finalized_at=@finalizedAt, metadata_json=@metadataJson WHERE id=@id AND route_revision=@expectedRevision`).run({ ...toRunRow(next), expectedRevision: expectedRevision ?? current.routeRevision });
      if (!result.changes) throw new OtmError('Route revision conflict.', { code: 'REVISION_CONFLICT', details: { expectedRevision, currentRevision: current.routeRevision, runId: run.id } });
      if (event) this.recordEvent(event);
      return next;
    });
  }

  updateRun(id, patch) {
    const current = this.getRun(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: patch.updatedAt || nowIso() };
    this.db.prepare(`UPDATE runs SET workspace_root=@workspaceRoot, session_id=@sessionId, turn_id=@turnId, prompt_hash=@promptHash, goal=@goal, status=@status,
      route_revision=@routeRevision, current_task_id=@currentTaskId, updated_at=@updatedAt, finalized_at=@finalizedAt, metadata_json=@metadataJson WHERE id=@id`).run(toRunRow(next));
    return next;
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? fromRunRow(row) : null;
  }

  getActiveRun(workspaceRoot, sessionId) {
    const scoped = arguments.length >= 2;
    const row = scoped
      ? this.db.prepare(`SELECT * FROM runs WHERE workspace_root = ? AND session_id IS ? AND status IN ('active','ready_to_finalize','blocked','paused') ORDER BY updated_at DESC LIMIT 1`).get(workspaceRoot, sessionId || null)
      : this.db.prepare(`SELECT * FROM runs WHERE workspace_root = ? AND status IN ('active','ready_to_finalize','blocked','paused') ORDER BY updated_at DESC LIMIT 1`).get(workspaceRoot);
    return row ? fromRunRow(row) : null;
  }

  listActiveRuns(workspaceRoot) {
    return this.db.prepare(`SELECT * FROM runs WHERE workspace_root = ? AND status IN ('active','ready_to_finalize','blocked','paused') ORDER BY updated_at DESC`).all(workspaceRoot).map(fromRunRow);
  }

  claimLegacyActiveRun(workspaceRoot, sessionId, metadata = {}) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM runs WHERE workspace_root = ? AND session_id IS NULL AND status IN ('active','ready_to_finalize','blocked','paused') ORDER BY updated_at DESC LIMIT 1`).get(workspaceRoot);
      if (!row) return null;
      const run = fromRunRow(row);
      const result = this.db.prepare(`UPDATE runs SET session_id = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND session_id IS NULL`)
        .run(sessionId, JSON.stringify({ ...(run.metadata || {}), ...metadata }), nowIso(), run.id);
      return result.changes ? this.getRun(run.id) : null;
    });
  }

  listRuns(workspaceRoot, limit = 20) {
    const stmt = workspaceRoot
      ? this.db.prepare('SELECT * FROM runs WHERE workspace_root = ? ORDER BY updated_at DESC LIMIT ?')
      : this.db.prepare('SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?');
    return (workspaceRoot ? stmt.all(workspaceRoot, limit) : stmt.all(limit)).map(fromRunRow);
  }

  exportWorkspace(workspaceRoot) {
    const runs = this.db.prepare('SELECT * FROM runs WHERE workspace_root = ? ORDER BY created_at ASC').all(workspaceRoot).map(fromRunRow);
    const runIds = runs.map((run) => run.id);
    const placeholders = runIds.map(() => '?').join(',');
    const byRun = (table, mapper) => runIds.length ? this.db.prepare(`SELECT * FROM ${table} WHERE run_id IN (${placeholders}) ORDER BY created_at ASC`).all(...runIds).map(mapper) : [];
    return {
      runs,
      tasks: byRun('tasks', fromTaskRow),
      events: byRun('events', fromEventRow),
      summaries: byRun('summaries', fromSummaryRow),
      cache: this.db.prepare('SELECT * FROM cache_entries WHERE workspace_root = ? ORDER BY created_at ASC').all(workspaceRoot).map(fromCacheRow)
    };
  }

  importWorkspace(payload) {
    return this.transaction(() => {
      assertSqliteImportDoesNotConflict(this.db, payload);
      const insertRun = this.db.prepare(`INSERT INTO runs (id, workspace_root, session_id, turn_id, prompt_hash, goal, status, route_revision, current_task_id, created_at, updated_at, finalized_at, metadata_json)
        VALUES (@id, @workspaceRoot, @sessionId, @turnId, @promptHash, @goal, @status, @routeRevision, @currentTaskId, @createdAt, @updatedAt, @finalizedAt, @metadataJson)`);
      const insertTask = this.db.prepare(`INSERT INTO tasks (id, run_id, parent_id, stable_key, title, description, status, required, priority, sort_order, created_by, acceptance_criteria_json, evidence_json, created_at, updated_at, completed_at, metadata_json)
        VALUES (@id, @runId, @parentId, @stableKey, @title, @description, @status, @required, @priority, @sortOrder, @createdBy, @acceptanceCriteriaJson, @evidenceJson, @createdAt, @updatedAt, @completedAt, @metadataJson)`);
      const insertEvent = this.db.prepare(`INSERT INTO events (id, run_id, turn_id, hook_event_name, event_type, idempotency_key, payload_json, created_at)
        VALUES (@id, @runId, @turnId, @hookEventName, @eventType, @idempotencyKey, @payloadJson, @createdAt)`);
      const insertSummary = this.db.prepare(`INSERT INTO summaries (id, run_id, workspace_root, turn_id, summary_md, summary_json, current_cleared, created_at)
        VALUES (@id, @runId, @workspaceRoot, @turnId, @summaryMd, @summaryJson, @currentCleared, @createdAt)`);
      const insertCache = this.db.prepare(`INSERT INTO cache_entries (id, workspace_root, kind, title, body, tags_json, source_json, score_hint, created_at, updated_at, expires_at)
        VALUES (@id, @workspaceRoot, @kind, @title, @body, @tagsJson, @sourceJson, @scoreHint, @createdAt, @updatedAt, @expiresAt)`);
      payload.runs.forEach((run) => insertRun.run(toRunRow(run)));
      payload.tasks.forEach((task) => insertTask.run(toTaskRow(task)));
      payload.events.forEach((event) => insertEvent.run(toEventRow(event)));
      payload.summaries.forEach((summary) => insertSummary.run(toSummaryRow(summary)));
      payload.cache.forEach((entry) => insertCache.run(toCacheRow(entry)));
      return Object.fromEntries(['runs', 'tasks', 'events', 'summaries', 'cache'].map((name) => [name, payload[name].length]));
    });
  }

  addTasks(tasks) {
    const stmt = this.db.prepare(`INSERT INTO tasks (id, run_id, parent_id, stable_key, title, description, status, required, priority, sort_order, created_by, acceptance_criteria_json, evidence_json, created_at, updated_at, completed_at, metadata_json)
      VALUES (@id, @runId, @parentId, @stableKey, @title, @description, @status, @required, @priority, @sortOrder, @createdBy, @acceptanceCriteriaJson, @evidenceJson, @createdAt, @updatedAt, @completedAt, @metadataJson)`);
    this.transaction(() => tasks.forEach((task) => stmt.run(toTaskRow(task))));
    return tasks;
  }

  updateTask(id, patch) {
    const current = this.getTask(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: patch.updatedAt || nowIso() };
    this.db.prepare(`UPDATE tasks SET parent_id=@parentId, stable_key=@stableKey, title=@title, description=@description, status=@status, required=@required,
      priority=@priority, sort_order=@sortOrder, created_by=@createdBy, acceptance_criteria_json=@acceptanceCriteriaJson, evidence_json=@evidenceJson,
      updated_at=@updatedAt, completed_at=@completedAt, metadata_json=@metadataJson WHERE id=@id`).run(toTaskRow(next));
    return next;
  }

  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? fromTaskRow(row) : null;
  }

  getTasks(runId) {
    return this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY sort_order ASC, created_at ASC').all(runId).map(fromTaskRow);
  }

  recordEvent(event) {
    this.db.prepare(`INSERT OR IGNORE INTO events (id, run_id, turn_id, hook_event_name, event_type, idempotency_key, payload_json, created_at)
      VALUES (@id, @runId, @turnId, @hookEventName, @eventType, @idempotencyKey, @payloadJson, @createdAt)`).run(toEventRow(event));
    return event;
  }

  getEvents(runId, limit = 100) {
    // Select the newest window, then present it chronologically like the JSON store.
    return this.db.prepare('SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC').all(runId, limit).map(fromEventRow);
  }

  upsertSummary(summary) {
    this.db.prepare(`INSERT INTO summaries (id, run_id, workspace_root, turn_id, summary_md, summary_json, current_cleared, created_at)
      VALUES (@id, @runId, @workspaceRoot, @turnId, @summaryMd, @summaryJson, @currentCleared, @createdAt)
      ON CONFLICT(id) DO UPDATE SET summary_md=excluded.summary_md, summary_json=excluded.summary_json, current_cleared=excluded.current_cleared`).run(toSummaryRow(summary));
    return summary;
  }

  listSummaries(workspaceRoot, limit = 20) {
    return this.db.prepare('SELECT * FROM summaries WHERE workspace_root = ? ORDER BY created_at DESC LIMIT ?').all(workspaceRoot, limit).map(fromSummaryRow);
  }

  upsertCache(entry) {
    const existing = this.db.prepare('SELECT created_at FROM cache_entries WHERE id = ?').get(entry.id);
    const next = { ...entry, createdAt: existing?.created_at || entry.createdAt };
    this.db.prepare(`INSERT INTO cache_entries (id, workspace_root, kind, title, body, tags_json, source_json, score_hint, created_at, updated_at, expires_at)
      VALUES (@id, @workspaceRoot, @kind, @title, @body, @tagsJson, @sourceJson, @scoreHint, @createdAt, @updatedAt, @expiresAt)
      ON CONFLICT(id) DO UPDATE SET workspace_root=excluded.workspace_root, kind=excluded.kind, title=excluded.title, body=excluded.body,
        tags_json=excluded.tags_json, source_json=excluded.source_json, score_hint=excluded.score_hint, updated_at=excluded.updated_at, expires_at=excluded.expires_at`).run(toCacheRow(next));
    return next;
  }

  deleteCache(filter = {}) {
    const clauses = [];
    const params = [];
    if (filter.id) { clauses.push('id = ?'); params.push(filter.id); }
    if (filter.workspaceRoot) { clauses.push('workspace_root = ?'); params.push(filter.workspaceRoot); }
    if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
    if (filter.tag) { clauses.push('EXISTS (SELECT 1 FROM json_each(cache_entries.tags_json) WHERE lower(value) = lower(?))'); params.push(filter.tag); }
    if (filter.expired) { clauses.push('expires_at IS NOT NULL AND expires_at <= ?'); params.push(filter.now || nowIso()); }
    if (!clauses.length) throw new OtmError('Cache deletion requires at least one selector.', { code: 'CACHE_SELECTOR_REQUIRED' });
    const result = this.db.prepare(`DELETE FROM cache_entries WHERE ${clauses.join(' AND ')}`).run(...params);
    return result.changes || 0;
  }

  listCache(workspaceRoot, limit = 100) {
    return this.db.prepare('SELECT * FROM cache_entries WHERE workspace_root = ? ORDER BY updated_at DESC LIMIT ?').all(workspaceRoot, limit).map(fromCacheRow);
  }

  pruneHistory(options = {}) {
    const workspaceRoot = options.workspaceRoot || null;
    const olderThan = options.olderThan;
    const now = options.now || nowIso();
    const dryRun = options.dryRun === true;
    if (!olderThan) throw new Error('olderThan is required for history pruning');

    const runWhere = [
      "status NOT IN ('active','ready_to_finalize','blocked','paused')",
      'COALESCE(finalized_at, updated_at, created_at) < ?'
    ];
    const runParams = [olderThan];
    if (workspaceRoot) {
      runWhere.unshift('workspace_root = ?');
      runParams.unshift(workspaceRoot);
    }
    const removableRuns = this.db.prepare(`SELECT id FROM runs WHERE ${runWhere.join(' AND ')}`).all(...runParams).map((row) => row.id);
    const runIdClause = removableRuns.length ? `run_id IN (${removableRuns.map(() => '?').join(',')})` : null;

    const counts = {
      runs: removableRuns.length,
      tasks: runIdClause ? this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${runIdClause}`).get(...removableRuns).count : 0,
      events: runIdClause ? this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE ${runIdClause}`).get(...removableRuns).count : 0,
      summaries: runIdClause ? this.db.prepare(`SELECT COUNT(*) AS count FROM summaries WHERE ${runIdClause}`).get(...removableRuns).count : 0,
      cacheEntries: countPrunableCacheEntries(this.db, { workspaceRoot, olderThan, now })
    };

    if (!dryRun) {
      this.transaction(() => {
        if (runIdClause) {
          this.db.prepare(`DELETE FROM tasks WHERE ${runIdClause}`).run(...removableRuns);
          this.db.prepare(`DELETE FROM events WHERE ${runIdClause}`).run(...removableRuns);
          this.db.prepare(`DELETE FROM summaries WHERE ${runIdClause}`).run(...removableRuns);
          this.db.prepare(`DELETE FROM runs WHERE id IN (${removableRuns.map(() => '?').join(',')})`).run(...removableRuns);
        }
        deletePrunableCacheEntries(this.db, { workspaceRoot, olderThan, now });
      });
    }

    return {
      dryRun,
      workspaceRoot,
      olderThan,
      retentionDays: options.retentionDays,
      deleted: counts
    };
  }
}

function cacheWhere({ workspaceRoot }) {
  const clauses = ['((expires_at IS NOT NULL AND expires_at <= ?) OR COALESCE(updated_at, created_at) < ?)'];
  if (workspaceRoot) clauses.unshift('workspace_root = ?');
  return clauses.join(' AND ');
}

function cacheParams({ workspaceRoot, olderThan, now }) {
  return workspaceRoot ? [workspaceRoot, now, olderThan] : [now, olderThan];
}

function countPrunableCacheEntries(db, options) {
  return db.prepare(`SELECT COUNT(*) AS count FROM cache_entries WHERE ${cacheWhere(options)}`).get(...cacheParams(options)).count;
}

function deletePrunableCacheEntries(db, options) {
  return db.prepare(`DELETE FROM cache_entries WHERE ${cacheWhere(options)}`).run(...cacheParams(options)).changes || 0;
}

function assertSqliteImportDoesNotConflict(db, payload) {
  const tables = { runs: 'runs', tasks: 'tasks', events: 'events', summaries: 'summaries', cache: 'cache_entries' };
  for (const [name, table] of Object.entries(tables)) {
    for (const item of payload[name]) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(item.id)) {
        throw new OtmError('Historical import conflicts with an existing record.', { code: 'IMPORT_CONFLICT', details: { collection: name, id: item.id } });
      }
    }
  }
  for (const event of payload.events) {
    if (db.prepare('SELECT 1 FROM events WHERE idempotency_key = ?').get(event.idempotencyKey)) {
      throw new OtmError('Historical import conflicts with an existing event idempotency key.', { code: 'IMPORT_CONFLICT', details: { collection: 'events', idempotencyKey: event.idempotencyKey } });
    }
  }
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    if ((Array.isArray(fallback) && !Array.isArray(parsed)) || (!Array.isArray(fallback) && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))) throw new Error('unexpected JSON shape');
    return parsed;
  } catch {
    throw new Error('SQLite store contains malformed JSON data. Run otm doctor and restore or repair the database.');
  }
}

function toRunRow(run) {
  return {
    id: run.id,
    workspaceRoot: run.workspaceRoot,
    sessionId: run.sessionId || null,
    turnId: run.turnId || null,
    promptHash: run.promptHash || null,
    goal: run.goal,
    status: run.status,
    routeRevision: run.routeRevision || 1,
    currentTaskId: run.currentTaskId || null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finalizedAt: run.finalizedAt || null,
    metadataJson: JSON.stringify(run.metadata || {})
  };
}

function fromRunRow(row) {
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    sessionId: row.session_id,
    turnId: row.turn_id,
    promptHash: row.prompt_hash,
    goal: row.goal,
    status: row.status,
    routeRevision: row.route_revision,
    currentTaskId: row.current_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

function toTaskRow(task) {
  return {
    id: task.id,
    runId: task.runId,
    parentId: task.parentId || null,
    stableKey: task.stableKey,
    title: task.title,
    description: task.description || null,
    status: task.status,
    required: task.required ? 1 : 0,
    priority: task.priority ?? 50,
    sortOrder: task.sortOrder ?? 0,
    createdBy: task.createdBy || 'manual',
    acceptanceCriteriaJson: JSON.stringify(task.acceptanceCriteria || []),
    evidenceJson: JSON.stringify(task.evidence || []),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null,
    metadataJson: JSON.stringify(task.metadata || {})
  };
}

function fromTaskRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id,
    stableKey: row.stable_key,
    title: row.title,
    description: row.description,
    status: row.status,
    required: Boolean(row.required),
    priority: row.priority,
    sortOrder: row.sort_order,
    createdBy: row.created_by,
    acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
    evidence: parseJson(row.evidence_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

function toEventRow(event) {
  return {
    id: event.id,
    runId: event.runId,
    turnId: event.turnId || null,
    hookEventName: event.hookEventName || null,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    payloadJson: JSON.stringify(event.payload || {}),
    createdAt: event.createdAt
  };
}

function fromEventRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    turnId: row.turn_id,
    hookEventName: row.hook_event_name,
    eventType: row.event_type,
    idempotencyKey: row.idempotency_key,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  };
}

function toSummaryRow(summary) {
  return {
    id: summary.id,
    runId: summary.runId,
    workspaceRoot: summary.workspaceRoot,
    turnId: summary.turnId || null,
    summaryMd: summary.summaryMd,
    summaryJson: JSON.stringify(summary.summaryJson || {}),
    currentCleared: summary.currentCleared ? 1 : 0,
    createdAt: summary.createdAt
  };
}

function fromSummaryRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceRoot: row.workspace_root,
    turnId: row.turn_id,
    summaryMd: row.summary_md,
    summaryJson: parseJson(row.summary_json, {}),
    currentCleared: Boolean(row.current_cleared),
    createdAt: row.created_at
  };
}

function toCacheRow(entry) {
  return {
    id: entry.id,
    workspaceRoot: entry.workspaceRoot,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    tagsJson: JSON.stringify(entry.tags || []),
    sourceJson: JSON.stringify(entry.source || {}),
    scoreHint: entry.scoreHint || 0,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt || null
  };
}

function fromCacheRow(row) {
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseJson(row.tags_json, []),
    source: parseJson(row.source_json, {}),
    scoreHint: row.score_hint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}
