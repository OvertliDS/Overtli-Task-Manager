import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir, currentJsonPath, workspaceStateDir } from '../core/fs-utils.mjs';
import { loadBetterSqlite3, SQLITE_SCHEMA_VERSION } from '../storage/sqlite-store.mjs';
import { RUN_STATUSES, TASK_STATUSES } from '../core/constants.mjs';

const ACTIVE_RUN_STATUSES = new Set(['active', 'ready_to_finalize', 'blocked', 'paused']);

/**
 * Read-only integrity inspection.  This deliberately does not construct a
 * store: both store constructors create their parent directory, and the JSON
 * constructor may quarantine malformed state as part of normal recovery.
 */
export function inspectDoctor({ workspaceRoot, packageRoot, sessionId, env = process.env }) {
  const checks = [];
  const add = (name, status, detail, data = undefined) => checks.push({ name, status, detail, ...(data === undefined ? {} : { data }) });
  const stateDir = env.OTM_STATE_DIR || getHomeDir(env);
  const requested = String(env.OTM_STORAGE || 'auto').toLowerCase();
  const sqlitePath = path.join(stateDir, 'state.sqlite');
  const jsonPath = path.join(stateDir, 'json', 'state.json');
  const sqliteAvailable = Boolean(loadBetterSqlite3());
  const useSqlite = requested === 'sqlite' || (requested === 'auto' && sqliteAvailable);

  add('runtime', supportsNode(process.versions.node) ? 'ok' : 'error', `Node ${process.versions.node}; requires Node 20.10 or newer.`, { node: process.versions.node });
  add('package', 'ok', `Package root: ${packageRoot}`);
  if (useSqlite) inspectSqlite({ sqlitePath, requested, add });
  else inspectJson({ jsonPath, stateDir, add });
  inspectWorkspaceFiles({ workspaceRoot, sessionId, add });
  inspectHooks({ workspaceRoot, add });

  const errors = checks.filter((check) => check.status === 'error').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  return {
    ok: errors === 0,
    status: errors ? 'error' : warnings ? 'warning' : 'ok',
    errors,
    warnings,
    workspaceRoot,
    sessionId: sessionId || null,
    storage: useSqlite ? 'sqlite' : 'json',
    statePath: useSqlite ? sqlitePath : jsonPath,
    checks
  };
}

export function renderDoctor(report) {
  const lines = ['## Overtli Task Manager doctor', '', `Workspace: \`${report.workspaceRoot}\``, `Storage: \`${report.storage}\``, `State: \`${report.statePath}\``, `Session: \`${report.sessionId || 'unscoped'}\``, `Status: **${report.status.toUpperCase()}** (${report.errors} errors, ${report.warnings} warnings)`, '', '### Checks', ''];
  for (const check of report.checks) lines.push(`- ${symbol(check.status)} **${check.name}:** ${check.detail}`);
  lines.push('', 'Doctor is read-only. Use `otm repair` for summary recovery, `otm restore --confirm` for a known-good backup, or `otm migrate` for a supported SQLite schema upgrade.');
  return `${lines.join('\n')}\n`;
}

function inspectJson({ jsonPath, stateDir, add }) {
  if (!fs.existsSync(jsonPath)) {
    add('json-state', 'warning', `No JSON state file exists at ${jsonPath}; a first normal write will initialize it.`);
    return;
  }
  let document;
  try { document = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (error) {
    add('json-state', 'error', `Malformed JSON state preserved in place: ${safeMessage(error)}. Restore a backup or run a deliberate repair.`);
    return;
  }
  const collections = ['runs', 'tasks', 'events', 'summaries', 'cache'];
  const missing = collections.filter((name) => !Array.isArray(document?.[name]));
  if (missing.length) {
    add('json-state', 'error', `State document has invalid collections: ${missing.join(', ')}.`);
    return;
  }
  add('json-state', 'ok', `Parsed ${jsonPath} without modifying it.`);
  inspectDocumentReferences(document, add);
  add('json-backup', fs.existsSync(`${jsonPath}.backup`) ? 'ok' : 'warning', fs.existsSync(`${jsonPath}.backup`) ? 'Recovery backup is present.' : `No rotating recovery backup found under ${stateDir}.`);
  inspectLock(path.join(path.dirname(jsonPath), 'state.lock'), add);
}

function inspectDocumentReferences(document, add) {
  const collections = ['runs', 'tasks', 'events', 'summaries', 'cache'];
  for (const collection of collections) {
    const ids = new Set();
    const duplicates = [];
    for (const value of document[collection]) {
      const id = value?.id;
      if (typeof id !== 'string' || !id) duplicates.push('(missing id)');
      else if (ids.has(id)) duplicates.push(id);
      else ids.add(id);
    }
    add(`${collection}-ids`, duplicates.length ? 'error' : 'ok', duplicates.length ? `Duplicate or missing IDs: ${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? '…' : ''}.` : `${document[collection].length} unique record IDs.`);
  }
  const runIds = new Set(document.runs.map((run) => run?.id));
  const orphanCounts = {
    tasks: document.tasks.filter((value) => !runIds.has(value?.runId)).length,
    events: document.events.filter((value) => !runIds.has(value?.runId)).length,
    summaries: document.summaries.filter((value) => !runIds.has(value?.runId)).length
  };
  const orphanTotal = Object.values(orphanCounts).reduce((total, count) => total + count, 0);
  add('references', orphanTotal ? 'error' : 'ok', orphanTotal ? `Orphaned records: tasks ${orphanCounts.tasks}, events ${orphanCounts.events}, summaries ${orphanCounts.summaries}.` : 'All task, event, and summary run references resolve.');
  const invalidStatuses = document.runs.filter((run) => !RUN_STATUSES.has(run?.status)).length + document.tasks.filter((task) => !TASK_STATUSES.has(task?.status)).length;
  add('statuses', invalidStatuses ? 'error' : 'ok', invalidStatuses ? `${invalidStatuses} unknown run or task statuses found.` : 'Run and task statuses are recognized.');
  inspectDuplicateActiveScopes(document.runs, add);
}

function inspectDuplicateActiveScopes(runs, add) {
  const scopes = new Map();
  for (const run of runs) {
    if (!ACTIVE_RUN_STATUSES.has(run?.status)) continue;
    const key = `${String(run.workspaceRoot || '').toLowerCase()}\u0000${String(run.sessionId || '')}`;
    scopes.set(key, [...(scopes.get(key) || []), run.id]);
  }
  const duplicates = [...scopes.values()].filter((ids) => ids.length > 1);
  add('active-scopes', duplicates.length ? 'error' : 'ok', duplicates.length ? `Duplicate active workspace/session scopes: ${duplicates.map((ids) => ids.join(', ')).join('; ')}.` : 'No duplicate active workspace/session scopes.');
}

function inspectSqlite({ sqlitePath, requested, add }) {
  const Database = loadBetterSqlite3();
  if (!Database) {
    add('sqlite-runtime', 'error', 'better-sqlite3 is unavailable; SQLite cannot be inspected or used.');
    return;
  }
  if (!fs.existsSync(sqlitePath)) {
    add('sqlite-state', requested === 'sqlite' ? 'warning' : 'ok', `No SQLite state database exists at ${sqlitePath}; no database was created by doctor.`);
    return;
  }
  let db;
  try {
    db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check').map((row) => row.integrity_check || String(row));
    add('sqlite-integrity', integrity.every((value) => value === 'ok') ? 'ok' : 'error', integrity.every((value) => value === 'ok') ? 'SQLite integrity_check returned ok.' : integrity.join('; '));
    const version = Number(db.pragma('user_version', { simple: true }) || 0);
    add('sqlite-schema', version === SQLITE_SCHEMA_VERSION ? 'ok' : version > SQLITE_SCHEMA_VERSION ? 'error' : 'warning', `Schema version ${version}; supported version ${SQLITE_SCHEMA_VERSION}.`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const required = ['runs', 'tasks', 'events', 'summaries', 'cache_entries'];
    const missing = required.filter((name) => !tables.has(name));
    if (missing.length) { add('sqlite-tables', 'error', `Missing tables: ${missing.join(', ')}.`); return; }
    const rows = db.prepare("SELECT id, workspace_root AS workspaceRoot, session_id AS sessionId, status FROM runs").all();
    inspectDuplicateActiveScopes(rows, add);
    const invalidStatuses = db.prepare(`
      SELECT (SELECT COUNT(*) FROM runs WHERE status IS NULL OR status NOT IN ('active','ready_to_finalize','completed','blocked','paused','cleared','abandoned','archived'))
        + (SELECT COUNT(*) FROM tasks WHERE status IS NULL OR status NOT IN ('pending','active','done','blocked','dropped','superseded') OR required IS NULL OR required NOT IN (0, 1))
        + (SELECT COUNT(*) FROM summaries WHERE current_cleared IS NULL OR current_cleared NOT IN (0, 1)) AS count
    `).get().count;
    add('statuses', Number(invalidStatuses) ? 'error' : 'ok', Number(invalidStatuses) ? `${invalidStatuses} invalid SQLite status or boolean values found.` : 'Run/task statuses and required booleans are valid.');
    const taskOrphans = db.prepare('SELECT COUNT(*) AS count FROM tasks t LEFT JOIN runs r ON r.id=t.run_id WHERE r.id IS NULL').get().count;
    const eventOrphans = db.prepare('SELECT COUNT(*) AS count FROM events e LEFT JOIN runs r ON r.id=e.run_id WHERE r.id IS NULL').get().count;
    const summaryOrphans = db.prepare('SELECT COUNT(*) AS count FROM summaries s LEFT JOIN runs r ON r.id=s.run_id WHERE r.id IS NULL').get().count;
    const total = Number(taskOrphans) + Number(eventOrphans) + Number(summaryOrphans);
    add('references', total ? 'error' : 'ok', total ? `Orphaned records: tasks ${taskOrphans}, events ${eventOrphans}, summaries ${summaryOrphans}.` : 'All task, event, and summary run references resolve.');
  } catch (error) {
    add('sqlite-state', 'error', `Unable to inspect SQLite database read-only: ${safeMessage(error)}.`);
  } finally { try { db?.close(); } catch {} }
}

function inspectWorkspaceFiles({ workspaceRoot, sessionId, add }) {
  const currentPath = currentJsonPath(workspaceRoot, sessionId);
  const indexPath = currentJsonPath(workspaceRoot);
  const current = parseJsonFile(currentPath);
  const index = parseJsonFile(indexPath);
  add('session-current', current.status === 'missing' ? 'ok' : current.status === 'error' ? 'error' : 'ok', current.status === 'missing' ? `No current file for this session (${currentPath}).` : current.status === 'error' ? `Malformed session current file: ${current.error}.` : `Session current file is valid (${currentPath}).`);
  add('workspace-index', index.status === 'missing' ? 'ok' : index.status === 'error' ? 'error' : 'ok', index.status === 'missing' ? `No workspace current index (${indexPath}).` : index.status === 'error' ? `Malformed workspace current index: ${index.error}.` : `Workspace current index is valid (${indexPath}).`);
  if (index.status === 'ok' && Number.isInteger(index.value?.activeSessionCount)) {
    const sessionsRoot = path.join(workspaceStateDir(workspaceRoot), 'sessions');
    let count = 0;
    if (fs.existsSync(sessionsRoot)) for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      const snapshot = parseJsonFile(path.join(sessionsRoot, entry.name, 'current.json'));
      if (snapshot.status === 'ok' && ACTIVE_RUN_STATUSES.has(snapshot.value?.run?.status)) count += 1;
    }
    add('snapshot-index', count === index.value.activeSessionCount ? 'ok' : 'warning', count === index.value.activeSessionCount ? `Index matches ${count} active session snapshots.` : `Index says ${index.value.activeSessionCount} active sessions but ${count} active session snapshots were found.`);
  }
}

function inspectHooks({ workspaceRoot, add }) {
  const hooksPath = path.join(workspaceRoot, '.codex', 'hooks.json');
  const parsed = parseJsonFile(hooksPath);
  if (parsed.status === 'missing') { add('hooks-json', 'warning', 'No workspace hooks.json is installed.'); return; }
  if (parsed.status === 'error') { add('hooks-json', 'error', `Malformed workspace hooks.json: ${parsed.error}.`); return; }
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) { add('hooks-json', 'error', 'Workspace hooks.json must contain an object.'); return; }
  add('hooks-json', 'ok', 'Workspace hooks.json is valid JSON.');
}

function inspectLock(lockPath, add) {
  const parsed = parseJsonFile(lockPath);
  if (parsed.status === 'missing') { add('json-lock', 'ok', 'No JSON write lock is present.'); return; }
  if (parsed.status === 'error') { add('json-lock', 'warning', `Lock is malformed and requires review: ${parsed.error}.`); return; }
  const pid = Number(parsed.value?.pid);
  const alive = Number.isInteger(pid) && pid > 0 ? processAlive(pid) : false;
  const ageMs = Math.max(0, Date.now() - Number(parsed.value?.heartbeatAt || parsed.value?.createdAt || 0));
  add('json-lock', alive ? 'warning' : 'warning', alive ? `Active-looking lock held by PID ${pid} (${Math.round(ageMs / 1000)}s heartbeat age); doctor will not steal it.` : `Stale-looking lock for PID ${Number.isFinite(pid) ? pid : 'unknown'} (${Math.round(ageMs / 1000)}s heartbeat age); inspect before cleanup.`);
}

function parseJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return { status: 'missing' };
  try { return { status: 'ok', value: JSON.parse(fs.readFileSync(filePath, 'utf8')) }; } catch (error) { return { status: 'error', error: safeMessage(error) }; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function supportsNode(version) {
  const [major = 0, minor = 0] = String(version).split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 10);
}

function safeMessage(error) { return String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 240); }
function symbol(status) { return status === 'ok' ? 'OK' : status === 'warning' ? 'WARN' : 'ERROR'; }
