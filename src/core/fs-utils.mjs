import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function pathExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function atomicWriteText(filePath, text) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function atomicWriteJson(filePath, value) {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}
`);
}

export function removeFileIfExists(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch {}
}

export function getHomeDir(env = process.env) {
  return env.OTM_HOME || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'overtli-task-manager');
}

export function findWorkspaceRoot(startCwd = process.cwd()) {
  let current = path.resolve(startCwd);
  while (true) {
    if (
      pathExists(path.join(current, '.git')) ||
      pathExists(path.join(current, 'AGENTS.md')) ||
      pathExists(path.join(current, 'AGENTS.override.md')) ||
      pathExists(path.join(current, 'package.json')) ||
      pathExists(path.join(current, 'pyproject.toml')) ||
      pathExists(path.join(current, 'Cargo.toml')) ||
      pathExists(path.join(current, 'go.mod'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startCwd);
    current = parent;
  }
}

export function workspaceStateDir(workspaceRoot) {
  return path.join(workspaceRoot, '.codex', 'overtli-task-manager');
}

export function currentJsonPath(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), 'current.json');
}

export function currentMarkdownPath(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), 'current.md');
}

export function summariesDir(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), 'summaries');
}

export function cacheDir(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), 'cache');
}

export function relativeToWorkspace(workspaceRoot, valuePath) {
  return path.relative(workspaceRoot, valuePath).split(path.sep).join('/');
}

export function hashFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

export function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
