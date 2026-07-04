import path from 'node:path';
import { getHomeDir, ensureDir } from '../core/fs-utils.mjs';
import { JsonStore } from './json-store.mjs';
import { SqliteStore, loadBetterSqlite3 } from './sqlite-store.mjs';

export function createStore({ env = process.env } = {}) {
  const stateDir = env.OTM_STATE_DIR || getHomeDir(env);
  ensureDir(stateDir);
  const requested = (env.OTM_STORAGE || 'auto').toLowerCase();

  if (requested !== 'json' && loadBetterSqlite3()) {
    const store = new SqliteStore({ stateDir });
    store.init();
    return store;
  }

  if (requested === 'sqlite') {
    throw new Error('OTM_STORAGE=sqlite was requested, but optional dependency better-sqlite3 is not installed. Run npm install or set OTM_STORAGE=json.');
  }

  const store = new JsonStore({ stateDir: path.join(stateDir, 'json') });
  store.init();
  return store;
}
