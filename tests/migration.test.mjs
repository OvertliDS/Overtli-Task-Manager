import './support/temp-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore, loadBetterSqlite3, SQLITE_SCHEMA_VERSION } from '../src/storage/sqlite-store.mjs';
import { handleCli } from '../src/cli/commands.mjs';

function tempWorkspace(prefix = 'otm-migration-workspace-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

async function capture(fn) {
  const original = console.log;
  const output = [];
  console.log = (value) => output.push(String(value));
  try { await fn(); return output; } finally { console.log = original; }
}

test('SQLite v1 fixtures migrate transactionally with a recovery copy', () => {
  const Database = loadBetterSqlite3();
  assert.ok(Database, 'better-sqlite3 is required for the SQLite conformance lane');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-sqlite-v1-migrate-'));
  const dbPath = path.join(stateDir, 'state.sqlite');
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, session_id TEXT, turn_id TEXT, prompt_hash TEXT, goal TEXT NOT NULL, status TEXT NOT NULL, route_revision INTEGER NOT NULL DEFAULT 1, current_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finalized_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'); PRAGMA user_version = 1;`);
  legacy.close();
  const store = new SqliteStore({ stateDir });
  try {
    store.init();
    assert.equal(store.db.pragma('user_version', { simple: true }), SQLITE_SCHEMA_VERSION);
  } finally { store.close(); }
  assert.equal(fs.readdirSync(stateDir).some((name) => name.startsWith('state.sqlite.pre-migration-v1-') && name.endsWith('.bak')), true);
});

test('SQLite v2 gains durable validation triggers and blocks malformed legacy values', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-sqlite-v2-migrate-'));
  const first = new SqliteStore({ stateDir });
  first.init();
  first.db.exec(`DROP TRIGGER otm_runs_status_insert; DROP TRIGGER otm_runs_status_update; DROP TRIGGER otm_tasks_status_insert; DROP TRIGGER otm_tasks_status_update; DROP TRIGGER otm_tasks_required_insert; DROP TRIGGER otm_tasks_required_update; DROP TRIGGER otm_summaries_cleared_insert; DROP TRIGGER otm_summaries_cleared_update; PRAGMA user_version = 2;`);
  first.close();
  const migrated = new SqliteStore({ stateDir });
  migrated.init();
  assert.equal(migrated.db.pragma('user_version', { simple: true }), SQLITE_SCHEMA_VERSION);
  assert.throws(() => migrated.db.prepare("INSERT INTO runs (id, status) VALUES ('bad-run', 'unknown')").run(), /OTM_INVALID_RUN_STATUS/);
  assert.throws(() => migrated.db.prepare("INSERT INTO tasks (id, status, required) VALUES ('bad-task', 'pending', 2)").run(), /OTM_INVALID_TASK_REQUIRED/);
  migrated.close();
  assert.equal(fs.readdirSync(stateDir).some((name) => name.startsWith('state.sqlite.pre-migration-v2-') && name.endsWith('.bak')), true);

  const malformedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-sqlite-invalid-v2-'));
  const legacy = new SqliteStore({ stateDir: malformedDir });
  legacy.init();
  legacy.db.exec(`INSERT INTO runs (id, workspace_root, session_id, goal, status, route_revision, created_at, updated_at, metadata_json) VALUES ('legacy-invalid', 'C:/workspace', NULL, 'Legacy', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}'); DROP TRIGGER otm_runs_status_insert; DROP TRIGGER otm_runs_status_update; DROP TRIGGER otm_tasks_status_insert; DROP TRIGGER otm_tasks_status_update; DROP TRIGGER otm_tasks_required_insert; DROP TRIGGER otm_tasks_required_update; DROP TRIGGER otm_summaries_cleared_insert; DROP TRIGGER otm_summaries_cleared_update; UPDATE runs SET status = 'invalid' WHERE id = 'legacy-invalid'; PRAGMA user_version = 2;`);
  legacy.close();
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const report = JSON.parse((await capture(() => handleCli({ argv: ['doctor', '--json'], cwd: tempWorkspace(), stdin: '', packageRoot, env: { ...process.env, OTM_STORAGE: 'sqlite', OTM_STATE_DIR: malformedDir } }))).at(-1));
  assert.equal(report.checks.find((check) => check.name === 'statuses').status, 'error');
  const blocked = new SqliteStore({ stateDir: malformedDir });
  try { assert.throws(() => blocked.init(), /migration blocked: invalid status or boolean values/i); } finally { blocked.close(); }
  assert.equal(fs.readdirSync(malformedDir).some((name) => name.startsWith('state.sqlite.pre-migration-v2-') && name.endsWith('.bak')), true);
});

test('CLI migration dry-run inspects legacy SQLite without changing it', async () => {
  const Database = loadBetterSqlite3();
  assert.ok(Database, 'better-sqlite3 is required for the SQLite conformance lane');
  const workspaceRoot = tempWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-cli-migrate-state-'));
  const dbPath = path.join(stateDir, 'state.sqlite');
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY); PRAGMA user_version = 1;`);
  legacy.close();
  const before = fs.statSync(dbPath);
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const output = await capture(() => handleCli({ argv: ['migrate', '--dry-run', '--json=true'], cwd: workspaceRoot, stdin: '', packageRoot, env: { ...process.env, OTM_STORAGE: 'sqlite', OTM_STATE_DIR: stateDir } }));
  const after = fs.statSync(dbPath);
  const inspected = JSON.parse(output.at(-1));
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(inspected.currentVersion, 1);
  assert.equal(inspected.targetVersion, SQLITE_SCHEMA_VERSION);
  assert.equal(fs.readdirSync(stateDir).some((name) => name.includes('pre-migration')), false);
  await assert.rejects(() => handleCli({ argv: ['migrate', '--dry-run', '--not-a-real-flag'], cwd: workspaceRoot, stdin: '', packageRoot, env: { ...process.env, OTM_STORAGE: 'sqlite', OTM_STATE_DIR: stateDir } }), /Unknown flag/);
});
