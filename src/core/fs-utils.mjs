import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_TEMP_MIN_AGE_MS = 60_000;
const DEFAULT_SCRATCH_MAX_AGE_MS = 30 * 60 * 1000;

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

export function atomicWriteText(filePath, text, options = {}) {
  ensureDir(path.dirname(filePath));
  if (readText(filePath, null) === text) return false;
  const tempDir = options.tempDir ? path.resolve(options.tempDir) : path.dirname(filePath);
  ensureDir(tempDir);
  const tmp = path.join(tempDir, `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (error) {
    removeFileIfExists(tmp);
    throw error;
  }
  return true;
}

export function atomicWriteJson(filePath, value, options = {}) {
  return atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}
`, options);
}

export function removeFileIfExists(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch {}
}

export function cleanupWorkspaceStateTempFiles(workspaceRoot, options = {}) {
  const stateDir = workspaceStateDir(workspaceRoot);
  const projectCacheDir = cacheDir(workspaceRoot);
  const tempDir = workspaceTempDir(workspaceRoot);
  const scratchDir = workspaceScratchDir(workspaceRoot);
  const minAgeMs = Number.isFinite(Number(options.minAgeMs)) ? Number(options.minAgeMs) : DEFAULT_TEMP_MIN_AGE_MS;
  const scratchMaxAgeMs = Number.isFinite(Number(options.scratchMaxAgeMs)) ? Number(options.scratchMaxAgeMs) : DEFAULT_SCRATCH_MAX_AGE_MS;
  return [
    ...cleanupTempFilesInDir(stateDir, { minAgeMs }),
    ...cleanupTempFilesInDir(projectCacheDir, { minAgeMs }),
    ...cleanupTempFilesInDir(tempDir, { minAgeMs }),
    ...cleanupScratchFilesInDir(scratchDir, { maxAgeMs: scratchMaxAgeMs })
  ];
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

export function workspaceTempDir(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), 'cache', 'tmp');
}

export function workspaceScratchDir(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), 'cache', 'scratch');
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

function cleanupTempFilesInDir(dir, { minAgeMs }) {
  if (!pathExists(dir)) return [];
  const now = Date.now();
  const removed = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isOtmAtomicTempName(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const stat = statSafe(filePath);
    if (!stat || (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs)) continue;
    try {
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    } catch {}
  }
  return removed;
}

function isOtmAtomicTempName(name) {
  return /^(?:current\.json|current\.md|install\.json|[^\\/]+\.md|[^\\/]+\.json)\.\d+\.\d+\.tmp$/i.test(String(name || ''));
}

function cleanupScratchFilesInDir(dir, { maxAgeMs }) {
  if (!pathExists(dir) || maxAgeMs < 0) return [];
  const now = Date.now();
  const removed = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    const stat = statSafe(filePath);
    if (!stat || (maxAgeMs > 0 && now - stat.mtimeMs < maxAgeMs)) continue;
    try {
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    } catch {}
  }
  return removed;
}
