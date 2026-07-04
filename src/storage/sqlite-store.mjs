import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureDir } from '../core/fs-utils.mjs';
import { nowIso } from '../core/ids.mjs';

const require = createRequire(import.meta.url);

export function loadBetterSqlite3() {
  try {
    return require('better-sqlite3');
  } catch {
    return null;
  }
}

export class SqliteStore {
  constructor({ stateDir }) {
    const BetterSqlite3 = loadBetterSqlite3();
    if (!BetterSqlite3) throw new Error('better-sqlite3 is not installed');
    this.kind = 'sqlite';
    this.stateDir = stateDir;
    ensureDir(stateDir);
    this.dbPath = path.join(stateDir, 'state.sqlite');
    this.db = new BetterSqlite3(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
  }

  init() {
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
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        turn_id TEXT,
        hook_event_name TEXT,
        event_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        turn_id TEXT,
        summary_md TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        current_cleared INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_runs_session_turn ON runs(session_id, turn_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_run_created ON events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cache_workspace_kind ON cache_entries(workspace_root, kind);
    `);
  }

  transaction(fn) {
    return this.db.transaction(() => fn())();
  }

  createRun(run) {
    this.db.prepare(`INSERT INTO runs (id, workspace_root, session_id, turn_id, prompt_hash, goal, status, route_revision, current_task_id, created_at, updated_at, finalized_at, metadata_json)
      VALUES (@id, @workspaceRoot, @sessionId, @turnId, @promptHash, @goal, @status, @routeRevision, @currentTaskId, @createdAt, @updatedAt, @finalizedAt, @metadataJson)`).run(toRunRow(run));
    return run;
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

  getActiveRun(workspaceRoot) {
    const row = this.db.prepare(`SELECT * FROM runs WHERE workspace_root = ? AND status IN ('active','blocked','paused') ORDER BY updated_at DESC LIMIT 1`).get(workspaceRoot);
    return row ? fromRunRow(row) : null;
  }

  listRuns(workspaceRoot, limit = 20) {
    const stmt = workspaceRoot
      ? this.db.prepare('SELECT * FROM runs WHERE workspace_root = ? ORDER BY updated_at DESC LIMIT ?')
      : this.db.prepare('SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?');
    return (workspaceRoot ? stmt.all(workspaceRoot, limit) : stmt.all(limit)).map(fromRunRow);
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
    return this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY created_at ASC LIMIT ?').all(runId, limit).map(fromEventRow);
  }

  upsertSummary(summary) {
    this.db.prepare(`INSERT OR REPLACE INTO summaries (id, run_id, workspace_root, turn_id, summary_md, summary_json, current_cleared, created_at)
      VALUES (@id, @runId, @workspaceRoot, @turnId, @summaryMd, @summaryJson, @currentCleared, @createdAt)`).run(toSummaryRow(summary));
    return summary;
  }

  listSummaries(workspaceRoot, limit = 20) {
    return this.db.prepare('SELECT * FROM summaries WHERE workspace_root = ? ORDER BY created_at DESC LIMIT ?').all(workspaceRoot, limit).map(fromSummaryRow);
  }

  upsertCache(entry) {
    this.db.prepare(`INSERT OR REPLACE INTO cache_entries (id, workspace_root, kind, title, body, tags_json, source_json, score_hint, created_at, updated_at, expires_at)
      VALUES (@id, @workspaceRoot, @kind, @title, @body, @tagsJson, @sourceJson, @scoreHint, @createdAt, @updatedAt, @expiresAt)`).run(toCacheRow(entry));
    return entry;
  }

  deleteCache(filter = {}) {
    const clauses = [];
    const params = [];
    if (filter.id) { clauses.push('id = ?'); params.push(filter.id); }
    if (filter.workspaceRoot) { clauses.push('workspace_root = ?'); params.push(filter.workspaceRoot); }
    if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
    if (!clauses.length) return 0;
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
      "status NOT IN ('active','blocked','paused')",
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

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
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
