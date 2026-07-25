import path from "node:path";
import fs from "node:fs";
import { getHomeDir, ensureDir } from "../core/fs-utils.mjs";
import { OtmError } from "../core/errors.mjs";
import { JsonStore } from "./json-store.mjs";
import {
  SqliteStore,
  createBetterSqlite3UnavailableError,
  inspectBetterSqlite3Runtime,
} from "./sqlite-store.mjs";

const STORAGE_BACKENDS = new Set(["auto", "sqlite", "json"]);

export function createStore({
  env = process.env,
  readOnly = false,
  sqliteRuntime = null,
} = {}) {
  const stateDir = env.OTM_STATE_DIR || getHomeDir(env);
  const requested = (env.OTM_STORAGE || "auto").toLowerCase();
  if (!STORAGE_BACKENDS.has(requested))
    throw new OtmError(
      `Invalid OTM_STORAGE value "${requested}". Expected auto, sqlite, or json.`,
      {
        code: "INVALID_STORAGE_BACKEND",
        details: { requested },
      },
    );
  const sqlitePath = path.join(stateDir, "state.sqlite");
  const jsonStateDir = path.join(stateDir, "json");
  const runtime =
    requested === "json"
      ? null
      : sqliteRuntime || inspectBetterSqlite3Runtime({ env });
  const sqliteAvailable = Boolean(runtime?.available);
  if (!sqliteAvailable && requested === "sqlite")
    throw createBetterSqlite3UnavailableError(runtime);

  if (readOnly) {
    if (sqliteAvailable && fsExists(sqlitePath)) {
      const store = new SqliteStore({ stateDir, readOnly: true });
      store.init();
      return store;
    }
    if (sqliteAvailable || requested === "sqlite")
      return new EmptyReadOnlyStore("sqlite");
    const store = new JsonStore({ stateDir: jsonStateDir, readOnly: true });
    store.init();
    return store;
  }

  ensureDir(stateDir);

  if (sqliteAvailable) {
    const store = new SqliteStore({ stateDir });
    store.init();
    return store;
  }

  if (requested === "sqlite") {
    throw createBetterSqlite3UnavailableError(runtime);
  }

  const store = new JsonStore({ stateDir: path.join(stateDir, "json") });
  store.init();
  return store;
}

function fsExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

class EmptyReadOnlyStore {
  constructor(kind) {
    this.kind = kind;
  }
  close() {}
  listSummaries() {
    return [];
  }
  listCache() {
    return [];
  }
  exportWorkspace() {
    return { runs: [], tasks: [], events: [], summaries: [], cache: [] };
  }
  pruneHistory(options = {}) {
    return {
      dryRun: true,
      workspaceRoot: options.workspaceRoot || null,
      olderThan: options.olderThan,
      retentionDays: options.retentionDays,
      deleted: { runs: 0, tasks: 0, events: 0, summaries: 0, cacheEntries: 0 },
    };
  }
}
