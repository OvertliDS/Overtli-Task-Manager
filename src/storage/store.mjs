import path from 'node:path';
import fs from 'node:fs';
import { getHomeDir, ensureDir } from '../core/fs-utils.mjs';
import { JsonStore } from './json-store.mjs';
import { SqliteStore, loadBetterSqlite3 } from './sqlite-store.mjs';

export function createStore({ env = process.env, readOnly = false } = {}) {
  const stateDir = env.OTM_STATE_DIR || getHomeDir(env);
  const requested = (env.OTM_STORAGE || 'auto').toLowerCase();
  const sqlitePath = path.join(stateDir, 'state.sqlite');
  const jsonStateDir = path.join(stateDir, 'json');
  const sqliteAvailable = requested !== 'json' && Boolean(loadBetterSqlite3());

  if (readOnly) {
    if (sqliteAvailable && fsExists(sqlitePath)) {
      const store = new SqliteStore({ stateDir, readOnly: true });
      store.init();
      return store;
    }
    if (sqliteAvailable || requested === 'sqlite') return new EmptyReadOnlyStore('sqlite');
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

  if (requested === 'sqlite') {
    throw new Error('OTM_STORAGE=sqlite was requested, but required dependency better-sqlite3 is not installed. Run npm install or explicitly set OTM_STORAGE=json.');
  }

  const store = new JsonStore({ stateDir: path.join(stateDir, 'json') });
  store.init();
  return store;
}

function fsExists(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

class EmptyReadOnlyStore {
  constructor(kind) { this.kind = kind; }
  close() {}
  listSummaries() { return []; }
  listCache() { return []; }
  exportWorkspace() { return { runs: [], tasks: [], events: [], summaries: [], cache: [] }; }
  pruneHistory(options = {}) {
    return { dryRun: true, workspaceRoot: options.workspaceRoot || null, olderThan: options.olderThan, retentionDays: options.retentionDays, deleted: { runs: 0, tasks: 0, events: 0, summaries: 0, cacheEntries: 0 } };
  }
}
