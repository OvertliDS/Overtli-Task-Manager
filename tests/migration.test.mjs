import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteStore,
  loadBetterSqlite3,
  SQLITE_SCHEMA_VERSION,
} from "../src/storage/sqlite-store.mjs";
import { handleCli } from "../src/cli/commands.mjs";

function tempWorkspace(prefix = "otm-migration-workspace-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

async function capture(fn) {
  const original = console.log;
  const output = [];
  console.log = (value) => output.push(String(value));
  try {
    await fn();
    return output;
  } finally {
    console.log = original;
  }
}

test("SQLite v1 fixtures migrate transactionally with a recovery copy", () => {
  const Database = loadBetterSqlite3();
  assert.ok(
    Database,
    "better-sqlite3 is required for the SQLite conformance lane",
  );
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-sqlite-v1-migrate-"),
  );
  const dbPath = path.join(stateDir, "state.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(
    `CREATE TABLE runs (id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, session_id TEXT, turn_id TEXT, prompt_hash TEXT, goal TEXT NOT NULL, status TEXT NOT NULL, route_revision INTEGER NOT NULL DEFAULT 1, current_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finalized_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'); PRAGMA user_version = 1;`,
  );
  legacy.close();
  const store = new SqliteStore({ stateDir });
  try {
    store.init();
    assert.equal(
      store.db.pragma("user_version", { simple: true }),
      SQLITE_SCHEMA_VERSION,
    );
  } finally {
    store.close();
  }
  assert.equal(
    fs
      .readdirSync(stateDir)
      .some(
        (name) =>
          name.startsWith("state.sqlite.pre-migration-v1-") &&
          name.endsWith(".bak"),
      ),
    true,
  );
});

test("SQLite v2 gains durable validation triggers and blocks malformed legacy values", async () => {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-sqlite-v2-migrate-"),
  );
  const first = new SqliteStore({ stateDir });
  first.init();
  first.db.exec(
    `DROP TRIGGER otm_runs_status_insert; DROP TRIGGER otm_runs_status_update; DROP TRIGGER otm_tasks_status_insert; DROP TRIGGER otm_tasks_status_update; DROP TRIGGER otm_tasks_required_insert; DROP TRIGGER otm_tasks_required_update; DROP TRIGGER otm_summaries_cleared_insert; DROP TRIGGER otm_summaries_cleared_update; PRAGMA user_version = 2;`,
  );
  first.close();
  const migrated = new SqliteStore({ stateDir });
  migrated.init();
  assert.equal(
    migrated.db.pragma("user_version", { simple: true }),
    SQLITE_SCHEMA_VERSION,
  );
  assert.throws(
    () =>
      migrated.db
        .prepare("INSERT INTO runs (id, status) VALUES ('bad-run', 'unknown')")
        .run(),
    /OTM_INVALID_RUN_STATUS/,
  );
  assert.throws(
    () =>
      migrated.db
        .prepare(
          "INSERT INTO tasks (id, status, required) VALUES ('bad-task', 'pending', 2)",
        )
        .run(),
    /OTM_INVALID_TASK_REQUIRED/,
  );
  migrated.close();
  assert.equal(
    fs
      .readdirSync(stateDir)
      .some(
        (name) =>
          name.startsWith("state.sqlite.pre-migration-v2-") &&
          name.endsWith(".bak"),
      ),
    true,
  );

  const malformedDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-sqlite-invalid-v2-"),
  );
  const legacy = new SqliteStore({ stateDir: malformedDir });
  legacy.init();
  legacy.db.exec(
    `INSERT INTO runs (id, workspace_root, session_id, goal, status, route_revision, created_at, updated_at, metadata_json) VALUES ('legacy-invalid', 'C:/workspace', NULL, 'Legacy', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}'); DROP TRIGGER otm_runs_status_insert; DROP TRIGGER otm_runs_status_update; DROP TRIGGER otm_tasks_status_insert; DROP TRIGGER otm_tasks_status_update; DROP TRIGGER otm_tasks_required_insert; DROP TRIGGER otm_tasks_required_update; DROP TRIGGER otm_summaries_cleared_insert; DROP TRIGGER otm_summaries_cleared_update; UPDATE runs SET status = 'invalid' WHERE id = 'legacy-invalid'; PRAGMA user_version = 2;`,
  );
  legacy.close();
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const report = JSON.parse(
    (
      await capture(() =>
        handleCli({
          argv: ["doctor", "--json"],
          cwd: tempWorkspace(),
          stdin: "",
          packageRoot,
          env: {
            ...process.env,
            OTM_STORAGE: "sqlite",
            OTM_STATE_DIR: malformedDir,
          },
        }),
      )
    ).at(-1),
  );
  assert.equal(
    report.checks.find((check) => check.name === "statuses").status,
    "error",
  );
  const blocked = new SqliteStore({ stateDir: malformedDir });
  try {
    assert.throws(
      () => blocked.init(),
      /migration blocked: invalid status or boolean values/i,
    );
  } finally {
    blocked.close();
  }
  assert.equal(
    fs
      .readdirSync(malformedDir)
      .some(
        (name) =>
          name.startsWith("state.sqlite.pre-migration-v2-") &&
          name.endsWith(".bak"),
      ),
    true,
  );
});

test("CLI migration dry-run inspects legacy SQLite without changing it", async () => {
  const Database = loadBetterSqlite3();
  assert.ok(
    Database,
    "better-sqlite3 is required for the SQLite conformance lane",
  );
  const workspaceRoot = tempWorkspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-cli-migrate-state-"),
  );
  const dbPath = path.join(stateDir, "state.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(
    `CREATE TABLE runs (id TEXT PRIMARY KEY); PRAGMA user_version = 1;`,
  );
  legacy.close();
  const before = fs.statSync(dbPath);
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const output = await capture(() =>
    handleCli({
      argv: ["migrate", "--dry-run", "--json=true"],
      cwd: workspaceRoot,
      stdin: "",
      packageRoot,
      env: { ...process.env, OTM_STORAGE: "sqlite", OTM_STATE_DIR: stateDir },
    }),
  );
  const after = fs.statSync(dbPath);
  const inspected = JSON.parse(output.at(-1));
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(inspected.currentVersion, 1);
  assert.equal(inspected.targetVersion, SQLITE_SCHEMA_VERSION);
  assert.equal(
    fs.readdirSync(stateDir).some((name) => name.includes("pre-migration")),
    false,
  );
  await assert.rejects(
    () =>
      handleCli({
        argv: ["migrate", "--dry-run", "--not-a-real-flag"],
        cwd: workspaceRoot,
        stdin: "",
        packageRoot,
        env: { ...process.env, OTM_STORAGE: "sqlite", OTM_STATE_DIR: stateDir },
      }),
    /Unknown flag/,
  );
});

test("SQLite v4 rebuilds legacy tables with real cascading foreign keys even when user_version is current", () => {
  const Database = loadBetterSqlite3();
  assert.ok(
    Database,
    "better-sqlite3 is required for the SQLite migration lane",
  );
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-sqlite-v4-fk-migrate-"),
  );
  const dbPath = path.join(stateDir, "state.sqlite");
  createLegacySchemaWithoutForeignKeys(Database, dbPath);

  const store = new SqliteStore({ stateDir });
  try {
    store.init();
    assert.equal(
      store.db.pragma("user_version", { simple: true }),
      SQLITE_SCHEMA_VERSION,
    );
    for (const table of ["tasks", "events", "summaries"]) {
      assert.ok(
        store.db
          .pragma(`foreign_key_list(${table})`)
          .some(
            (entry) =>
              entry.table === "runs" &&
              entry.from === "run_id" &&
              String(entry.on_delete).toUpperCase() === "CASCADE",
          ),
        `${table} must reference runs(id) with ON DELETE CASCADE`,
      );
    }
    assert.equal(store.getTask("task-legacy").title, "Legacy task");
    assert.equal(store.getEvents("run-legacy", 10)[0].id, "event-legacy");
    assert.equal(
      store.listSummaries("C:/workspace", 10)[0].id,
      "summary-legacy",
    );

    store.db.prepare("DELETE FROM runs WHERE id = ?").run("run-legacy");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
      0,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
      0,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM summaries").get().count,
      0,
    );
  } finally {
    store.close();
  }
  assert.equal(
    fs
      .readdirSync(stateDir)
      .some(
        (name) =>
          name.startsWith("state.sqlite.pre-migration-v4-") &&
          name.endsWith(".bak"),
      ),
    true,
  );
});

test("SQLite v4 foreign-key rebuild blocks orphaned legacy rows and preserves a recovery backup", () => {
  const Database = loadBetterSqlite3();
  assert.ok(
    Database,
    "better-sqlite3 is required for the SQLite migration lane",
  );
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-sqlite-v4-orphan-"),
  );
  const dbPath = path.join(stateDir, "state.sqlite");
  createLegacySchemaWithoutForeignKeys(Database, dbPath, { orphanTask: true });

  const store = new SqliteStore({ stateDir });
  try {
    assert.throws(
      () => store.init(),
      /migration blocked: orphaned rows found/i,
    );
  } finally {
    store.close();
  }
  const preserved = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(
      preserved
        .prepare("SELECT run_id FROM tasks WHERE id = ?")
        .get("task-legacy").run_id,
      "missing-run",
    );
    assert.equal(preserved.pragma("user_version", { simple: true }), 4);
  } finally {
    preserved.close();
  }
  assert.equal(
    fs
      .readdirSync(stateDir)
      .some(
        (name) =>
          name.startsWith("state.sqlite.pre-migration-v4-") &&
          name.endsWith(".bak"),
      ),
    true,
  );
});

function createLegacySchemaWithoutForeignKeys(
  Database,
  dbPath,
  { orphanTask = false } = {},
) {
  const db = new Database(dbPath);
  const taskRunId = orphanTask ? "missing-run" : "run-legacy";
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, session_id TEXT,
        turn_id TEXT, prompt_hash TEXT, goal TEXT NOT NULL, status TEXT NOT NULL,
        route_revision INTEGER NOT NULL DEFAULT 1, current_task_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finalized_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT,
        stable_key TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 50, sort_order INTEGER NOT NULL,
        created_by TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, turn_id TEXT,
        hook_event_name TEXT, event_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE summaries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, workspace_root TEXT NOT NULL,
        turn_id TEXT, summary_md TEXT NOT NULL, summary_json TEXT NOT NULL,
        current_cleared INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE cache_entries (
        id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]',
        source_json TEXT NOT NULL DEFAULT '{}', score_hint REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
      );
      INSERT INTO runs (
        id, workspace_root, session_id, turn_id, prompt_hash, goal, status,
        route_revision, current_task_id, created_at, updated_at, finalized_at,
        metadata_json
      ) VALUES (
        'run-legacy', 'C:/workspace', 'session-legacy', 'turn-legacy', NULL,
        'Legacy route', 'completed', 2, NULL, '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '{}'
      );
      INSERT INTO tasks (
        id, run_id, parent_id, stable_key, title, description, status, required,
        priority, sort_order, created_by, acceptance_criteria_json, evidence_json,
        created_at, updated_at, completed_at, metadata_json
      ) VALUES (
        'task-legacy', '${taskRunId}', NULL, 'legacy-task', 'Legacy task', NULL,
        'done', 1, 50, 1, 'migration-test', '[]', '[]',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z', '{}'
      );
      INSERT INTO events (
        id, run_id, turn_id, hook_event_name, event_type, idempotency_key,
        payload_json, created_at
      ) VALUES (
        'event-legacy', 'run-legacy', 'turn-legacy', NULL, 'turn_finalized',
        'legacy-event', '{}', '2026-01-02T00:00:00.000Z'
      );
      INSERT INTO summaries (
        id, run_id, workspace_root, turn_id, summary_md, summary_json,
        current_cleared, created_at
      ) VALUES (
        'summary-legacy', 'run-legacy', 'C:/workspace', 'turn-legacy',
        'Legacy summary', '{}', 1, '2026-01-02T00:00:00.000Z'
      );
      PRAGMA user_version = 4;
    `);
  } finally {
    db.close();
  }
}
