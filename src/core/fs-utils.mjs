import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { sessionScopeKey } from "./session-scope.mjs";
import { OtmError } from "./errors.mjs";

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

export function readText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Read an OTM-owned JSON artifact without turning corruption into an empty
 * value.  Callers that would otherwise overwrite a current snapshot or serve
 * it through MCP use this instead of the intentionally lenient generic
 * `readJson` helper.
 */
export function readOtmJsonArtifact(filePath, { allowMissing = true } = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw new OtmError(
      "Unable to read an OTM JSON artifact. Preserve the file and use doctor or repair before retrying.",
      {
        code: "SNAPSHOT_READ_FAILED",
        details: { path: filePath, reason: error?.code || "READ_FAILED" },
      },
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OtmError(
      "An OTM JSON artifact is malformed. It was preserved; run doctor and repair or restore a known-good backup before retrying.",
      {
        code: "SNAPSHOT_CORRUPTION",
        details: {
          path: filePath,
          reason: String(error?.message || "INVALID_JSON").slice(0, 160),
        },
      },
    );
  }
}

export function atomicWriteText(filePath, text, options = {}) {
  ensureDir(path.dirname(filePath));
  if (readText(filePath, null) === text) return false;
  const tempDir = options.tempDir
    ? path.resolve(options.tempDir)
    : path.dirname(filePath);
  ensureDir(tempDir);
  const tmp = path.join(
    tempDir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (error) {
    removeFileIfExists(tmp);
    throw error;
  }
  return true;
}

export function atomicWriteJson(filePath, value, options = {}) {
  return atomicWriteText(
    filePath,
    `${JSON.stringify(value, null, 2)}
`,
    options,
  );
}

export function removeFileIfExists(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

export function cleanupWorkspaceStateTempFiles(workspaceRoot, options = {}) {
  const stateDir = workspaceStateDir(workspaceRoot);
  const projectCacheDir = cacheDir(workspaceRoot);
  const tempDir = workspaceTempDir(workspaceRoot);
  const scratchDirs = (
    options.sessionId
      ? [workspaceScratchDir(workspaceRoot, options.sessionId)]
      : workspaceScratchDirs(workspaceRoot)
  ).filter(
    (scratchDir) =>
      !new Set(options.excludeSessionIds || []).has(
        path.basename(path.dirname(path.dirname(scratchDir))),
      ),
  );
  const minAgeMs = Number.isFinite(Number(options.minAgeMs))
    ? Number(options.minAgeMs)
    : DEFAULT_TEMP_MIN_AGE_MS;
  const scratchMaxAgeMs = Number.isFinite(Number(options.scratchMaxAgeMs))
    ? Number(options.scratchMaxAgeMs)
    : DEFAULT_SCRATCH_MAX_AGE_MS;
  const dryRun = options.dryRun === true;
  return [
    ...cleanupTempFilesInDir(stateDir, { minAgeMs, dryRun }),
    ...cleanupTempFilesInDir(projectCacheDir, { minAgeMs, dryRun }),
    ...cleanupTempFilesInDir(tempDir, { minAgeMs, dryRun }),
    ...scratchDirs.flatMap((scratchDir) =>
      cleanupScratchFilesInDir(scratchDir, {
        maxAgeMs: scratchMaxAgeMs,
        dryRun,
      }),
    ),
  ];
}

export function getHomeDir(env = process.env) {
  return (
    env.OTM_HOME ||
    path.join(
      env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "overtli-task-manager",
    )
  );
}

export function findWorkspaceRoot(startCwd = process.cwd()) {
  let current = path.resolve(startCwd);
  let fallback = null;
  while (true) {
    if (pathExists(path.join(current, ".git"))) return current;
    if (
      !fallback &&
      (pathExists(path.join(current, "AGENTS.md")) ||
        pathExists(path.join(current, "AGENTS.override.md")) ||
        pathExists(path.join(current, "package.json")) ||
        pathExists(path.join(current, "pyproject.toml")) ||
        pathExists(path.join(current, "Cargo.toml")) ||
        pathExists(path.join(current, "go.mod")))
    )
      fallback = current;
    const parent = path.dirname(current);
    if (parent === current) return fallback || path.resolve(startCwd);
    current = parent;
  }
}

export function workspaceStateDir(workspaceRoot) {
  return path.join(workspaceRoot, ".codex", "overtli-task-manager");
}

export function workspaceTempDir(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "cache", "tmp");
}

export function workspaceScratchDir(workspaceRoot, sessionId = null) {
  return path.join(
    sessionStateDir(workspaceRoot, sessionId),
    "cache",
    "scratch",
  );
}

export function sessionStateDir(workspaceRoot, sessionId) {
  const key = sessionScopeKey(sessionId);
  return key
    ? path.join(workspaceStateDir(workspaceRoot), "sessions", key)
    : workspaceStateDir(workspaceRoot);
}

export function currentJsonPath(workspaceRoot, sessionId = null) {
  return path.join(sessionStateDir(workspaceRoot, sessionId), "current.json");
}

export function currentMarkdownPath(workspaceRoot, sessionId = null) {
  return path.join(sessionStateDir(workspaceRoot, sessionId), "current.md");
}

export function summariesDir(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "summaries");
}

export function cacheDir(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "cache");
}

export function relativeToWorkspace(workspaceRoot, valuePath) {
  return path.relative(workspaceRoot, valuePath).split(path.sep).join("/");
}

export function hashFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
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

function cleanupTempFilesInDir(dir, { minAgeMs, dryRun = false }) {
  if (!pathExists(dir)) return [];
  const now = Date.now();
  const removed = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isOtmAtomicTempName(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const stat = statSafe(filePath);
    if (!stat || (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs)) continue;
    if (dryRun) {
      removed.push(filePath);
      continue;
    }
    try {
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    } catch {}
  }
  return removed;
}

function isOtmAtomicTempName(name) {
  return /^(?:current\.json|current\.md|install\.json|[^\\/]+\.md|[^\\/]+\.json)\.\d+\.\d+\.tmp$/i.test(
    String(name || ""),
  );
}

function cleanupScratchFilesInDir(dir, { maxAgeMs, dryRun = false }) {
  if (!pathExists(dir) || maxAgeMs < 0) return [];
  const now = Date.now();
  const removed = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    const stat = statSafe(filePath);
    if (!stat || (maxAgeMs > 0 && now - stat.mtimeMs < maxAgeMs)) continue;
    if (dryRun) {
      removed.push(filePath);
      continue;
    }
    try {
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    } catch {}
  }
  return removed;
}

function workspaceScratchDirs(workspaceRoot) {
  const dirs = [workspaceScratchDir(workspaceRoot)];
  const sessionsRoot = path.join(workspaceStateDir(workspaceRoot), "sessions");
  if (!pathExists(sessionsRoot)) return dirs;
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (entry.isDirectory())
      dirs.push(path.join(sessionsRoot, entry.name, "cache", "scratch"));
  }
  return dirs;
}
