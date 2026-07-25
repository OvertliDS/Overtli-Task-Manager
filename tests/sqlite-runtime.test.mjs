import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeBetterSqlite3Failure,
  probeBetterSqlite3Runtime,
  repairBetterSqlite3Runtime,
  resolveNpmInvocation,
} from "../src/storage/sqlite-store.mjs";
import { createStore } from "../src/storage/store.mjs";
import { inspectDoctor } from "../src/cli/doctor.mjs";

function tempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otm-sqlite-runtime-"));
}

function incompatibleRuntime() {
  const error = new Error("compiled against a different Node.js version");
  error.code = "ERR_DLOPEN_FAILED";
  return { available: false, Database: null, error };
}

test("native runtime probe constructs and closes a database", () => {
  let closed = false;
  class FakeDatabase {
    prepare() {
      return { get: () => ({ ok: 1 }) };
    }
    close() {
      closed = true;
    }
  }
  const runtime = probeBetterSqlite3Runtime(() => FakeDatabase);
  assert.equal(runtime.available, true);
  assert.equal(runtime.Database, FakeDatabase);
  assert.equal(closed, true);
});

test("native runtime probe detects lazy ABI load failures", () => {
  const runtime = probeBetterSqlite3Runtime(() => {
    return class BrokenDatabase {
      constructor() {
        const error = new Error("compiled against a different Node.js version");
        error.code = "ERR_DLOPEN_FAILED";
        throw error;
      }
    };
  });
  assert.equal(runtime.available, false);
  assert.equal(runtime.Database, null);
  assert.equal(runtime.error.code, "ERR_DLOPEN_FAILED");
  assert.match(describeBetterSqlite3Failure(runtime), /module ABI/);
  assert.match(
    describeBetterSqlite3Failure(runtime),
    /npm rebuild better-sqlite3 --foreground-scripts/,
  );
});

test("explicit SQLite fails clearly when the native runtime is unavailable", () => {
  const stateDir = tempStateDir();
  assert.throws(
    () =>
      createStore({
        env: { OTM_STORAGE: "sqlite", OTM_STATE_DIR: stateDir },
        readOnly: true,
        sqliteRuntime: incompatibleRuntime(),
      }),
    {
      code: "SQLITE_RUNTIME_UNAVAILABLE",
    },
  );
});

test("ABI mismatch auto-repair retries the native runtime once", () => {
  const packageRoot = tempStateDir();
  fs.mkdirSync(path.join(packageRoot, "node_modules"));
  let rebuilds = 0;
  const Database = class {};
  const runtime = repairBetterSqlite3Runtime({
    runtime: incompatibleRuntime(),
    packageRoot,
    env: {},
    rebuild: () => {
      rebuilds += 1;
      return { status: 0, signal: null, error: null };
    },
    probe: () => ({ available: true, Database, error: null }),
  });
  assert.equal(rebuilds, 1);
  assert.equal(runtime.available, true);
  assert.equal(runtime.Database, Database);
  assert.deepEqual(runtime.repair, {
    attempted: true,
    succeeded: true,
    reason: "rebuilt",
    exitCode: 0,
    signal: null,
    errorCode: null,
  });
  assert.equal(
    fs.existsSync(
      path.join(
        packageRoot,
        "node_modules",
        ".otm-better-sqlite3-rebuild.lock",
      ),
    ),
    false,
  );
});

test("ABI mismatch auto-repair honors the opt-out and CI suppression", () => {
  for (const env of [{ OTM_AUTO_REBUILD_SQLITE: "0" }, { CI: "1" }]) {
    let rebuilds = 0;
    const runtime = repairBetterSqlite3Runtime({
      runtime: incompatibleRuntime(),
      packageRoot: tempStateDir(),
      env,
      rebuild: () => {
        rebuilds += 1;
        return { status: 0 };
      },
    });
    assert.equal(rebuilds, 0);
    assert.equal(runtime.available, false);
  }
});

test("ABI mismatch auto-repair reports rebuild process failures", () => {
  const packageRoot = tempStateDir();
  fs.mkdirSync(path.join(packageRoot, "node_modules"));
  const rebuildError = new Error("npm could not be started");
  rebuildError.code = "ENOENT";
  const runtime = repairBetterSqlite3Runtime({
    runtime: incompatibleRuntime(),
    packageRoot,
    env: {},
    rebuild: () => ({
      status: 1,
      signal: "SIGTERM",
      error: rebuildError,
    }),
    probe: incompatibleRuntime,
  });
  assert.equal(runtime.available, false);
  assert.deepEqual(runtime.repair, {
    attempted: true,
    succeeded: false,
    reason: "rebuild-failed",
    exitCode: 1,
    signal: "SIGTERM",
    errorCode: "ENOENT",
  });
});

test("ABI mismatch auto-repair converts thrown rebuild errors to diagnostics", () => {
  const packageRoot = tempStateDir();
  fs.mkdirSync(path.join(packageRoot, "node_modules"));
  const error = new Error("spawn denied");
  error.code = "EACCES";
  const runtime = repairBetterSqlite3Runtime({
    runtime: incompatibleRuntime(),
    packageRoot,
    env: {},
    rebuild: () => {
      throw error;
    },
  });
  assert.equal(runtime.available, false);
  assert.deepEqual(runtime.repair, {
    attempted: false,
    succeeded: false,
    reason: "rebuild-error",
    errorCode: "EACCES",
  });
});

test("ABI mismatch auto-repair times out behind an active rebuild lock", () => {
  const packageRoot = tempStateDir();
  const nodeModules = path.join(packageRoot, "node_modules");
  fs.mkdirSync(nodeModules);
  fs.writeFileSync(
    path.join(nodeModules, ".otm-better-sqlite3-rebuild.lock"),
    JSON.stringify({ pid: process.pid }),
  );
  let rebuilds = 0;
  const runtime = repairBetterSqlite3Runtime({
    runtime: incompatibleRuntime(),
    packageRoot,
    env: {},
    rebuild: () => {
      rebuilds += 1;
      return { status: 0 };
    },
    probe: incompatibleRuntime,
    timeoutMs: 25,
  });
  assert.equal(rebuilds, 0);
  assert.equal(runtime.available, false);
  assert.equal(runtime.repair.reason, "lock-timeout");
});

test("ABI mismatch auto-repair reclaims an abandoned stale lock", () => {
  const packageRoot = tempStateDir();
  const nodeModules = path.join(packageRoot, "node_modules");
  const lockPath = path.join(nodeModules, ".otm-better-sqlite3-rebuild.lock");
  fs.mkdirSync(nodeModules);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647 }));
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockPath, staleTime, staleTime);
  let rebuilds = 0;
  let probes = 0;
  const runtime = repairBetterSqlite3Runtime({
    runtime: incompatibleRuntime(),
    packageRoot,
    env: {},
    rebuild: () => {
      rebuilds += 1;
      return { status: 0, signal: null, error: null };
    },
    probe: () => {
      probes += 1;
      return probes === 1
        ? incompatibleRuntime()
        : { available: true, Database: class {}, error: null };
    },
    timeoutMs: 1_000,
  });
  assert.equal(rebuilds, 1);
  assert.equal(runtime.available, true);
  assert.equal(runtime.repair.reason, "rebuilt");
  assert.equal(fs.existsSync(lockPath), false);
});

test("native runtime diagnostics distinguish missing and generic failures", () => {
  const missing = new Error("Cannot find module 'better-sqlite3'");
  missing.code = "MODULE_NOT_FOUND";
  assert.match(
    describeBetterSqlite3Failure({
      available: false,
      Database: null,
      error: missing,
    }),
    /is not installed/,
  );

  const generic = new Error("native initialization failed");
  generic.code = "EIO";
  assert.match(
    describeBetterSqlite3Failure({
      available: false,
      Database: null,
      error: generic,
    }),
    /could not be initialized/,
  );
});

test("automatic rebuild resolves npm through the active Node installation", () => {
  const invocation = resolveNpmInvocation({});
  assert.equal(typeof invocation.command, "string");
  assert.ok(invocation.command.length > 0);
  assert.ok(Array.isArray(invocation.prefixArgs));
  if (process.platform === "win32") {
    assert.ok(
      invocation.command === process.execPath ||
        /(?:^|[\\/])cmd(?:\.exe)?$/i.test(invocation.command),
    );
  }
});

test("a peer-completed rebuild is reused without a competing rebuild", () => {
  const packageRoot = tempStateDir();
  const nodeModules = path.join(packageRoot, "node_modules");
  fs.mkdirSync(nodeModules);
  fs.writeFileSync(
    path.join(nodeModules, ".otm-better-sqlite3-rebuild.lock"),
    JSON.stringify({ pid: process.pid }),
  );
  let rebuilds = 0;
  const runtime = repairBetterSqlite3Runtime({
    runtime: incompatibleRuntime(),
    packageRoot,
    env: {},
    rebuild: () => {
      rebuilds += 1;
      return { status: 0 };
    },
    probe: () => ({ available: true, Database: class {}, error: null }),
    timeoutMs: 50,
  });
  assert.equal(rebuilds, 0);
  assert.equal(runtime.available, true);
  assert.equal(runtime.repair.reason, "repaired-by-peer");
});

test("auto storage falls back to JSON without deleting existing SQLite state", () => {
  const stateDir = tempStateDir();
  fs.writeFileSync(path.join(stateDir, "state.sqlite"), "existing-state");
  const store = createStore({
    env: { OTM_STORAGE: "auto", OTM_STATE_DIR: stateDir },
    sqliteRuntime: incompatibleRuntime(),
  });
  try {
    assert.equal(store.kind, "json");
    assert.equal(
      fs.readFileSync(path.join(stateDir, "state.sqlite"), "utf8"),
      "existing-state",
    );
  } finally {
    store.close();
  }
});

test("doctor reports JSON fallback and preserved inactive SQLite state", () => {
  const workspaceRoot = tempStateDir();
  const stateDir = tempStateDir();
  fs.writeFileSync(path.join(stateDir, "state.sqlite"), "existing-state");
  const report = inspectDoctor({
    workspaceRoot,
    packageRoot: workspaceRoot,
    env: { OTM_STORAGE: "auto", OTM_STATE_DIR: stateDir },
    sqliteRuntime: incompatibleRuntime(),
  });
  assert.equal(report.storage, "json");
  assert.equal(report.status, "warning");
  assert.equal(
    report.checks.find((check) => check.name === "sqlite-runtime")?.status,
    "warning",
  );
  assert.match(
    report.checks.find((check) => check.name === "sqlite-fallback")?.detail,
    /using JSON fallback/,
  );
});

test("auto storage may use JSON only when no SQLite state exists", () => {
  const stateDir = tempStateDir();
  const store = createStore({
    env: { OTM_STORAGE: "auto", OTM_STATE_DIR: stateDir },
    sqliteRuntime: incompatibleRuntime(),
  });
  try {
    assert.equal(store.kind, "json");
  } finally {
    store.close();
  }
});

test("invalid storage configuration is rejected", () => {
  assert.throws(
    () =>
      createStore({
        env: {
          OTM_STORAGE: "sqllite",
          OTM_STATE_DIR: tempStateDir(),
        },
      }),
    {
      code: "INVALID_STORAGE_BACKEND",
    },
  );
});
