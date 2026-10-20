import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OtmError } from "../core/errors.mjs";

const CLAUDE_HOOKS = Object.freeze([
  {
    event: "SessionStart",
    matcher: "startup|resume|clear|compact|fork",
    timeout: 15,
  },
  { event: "UserPromptSubmit", timeout: 12, onFailure: "block" },
  { event: "PreToolUse", matcher: "*", timeout: 8, onFailure: "block" },
  { event: "PostToolUse", matcher: "*", timeout: 12 },
  { event: "PostToolUseFailure", matcher: "*", timeout: 12 },
  { event: "SubagentStart", matcher: "*", timeout: 8 },
  { event: "SubagentStop", matcher: "*", timeout: 12 },
  { event: "Stop", timeout: 45 },
  { event: "PreCompact", matcher: "manual|auto", timeout: 15 },
  { event: "PostCompact", matcher: "manual|auto", timeout: 15 },
  {
    event: "SessionEnd",
    matcher: "clear|resume|logout|prompt_input_exit|other",
    timeout: 1,
  },
]);

const MANAGED_STATUS_PREFIX = "Overtli Task Manager:";

export function resolveClaudeUserSettingsPath({ homeDir = os.homedir() } = {}) {
  return path.join(path.resolve(homeDir), ".claude", "settings.json");
}

export function buildClaudeHookEntries({
  packageRoot,
  nodePath = process.execPath,
  hostEvidenceModulePath = null,
  stateDir = null,
  storage = null,
} = {}) {
  if (typeof packageRoot !== "string" || !packageRoot.trim()) {
    throw new OtmError("packageRoot is required to configure Claude hooks.", {
      code: "CLAUDE_PACKAGE_ROOT_REQUIRED",
    });
  }
  const executable = path.resolve(nodePath);
  const hookScript = path.resolve(packageRoot, "hooks", "claude-code.mjs");
  const evidenceArgs = [];
  if (hostEvidenceModulePath !== null) {
    if (
      typeof hostEvidenceModulePath !== "string" ||
      !path.isAbsolute(hostEvidenceModulePath)
    ) {
      throw new OtmError("Host evidence module path must be absolute.", {
        code: "HOST_EVIDENCE_MODULE_PATH_INVALID",
      });
    }
    const evidencePath = path.resolve(hostEvidenceModulePath);
    const evidenceStat = fs.lstatSync(evidencePath);
    if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink()) {
      throw new OtmError("Host evidence module must be a regular local file.", {
        code: "HOST_EVIDENCE_MODULE_INVALID",
        details: { evidencePath },
      });
    }
    evidenceArgs.push("--host-evidence-module", evidencePath);
  }
  const runtimeArgs = [];
  if (stateDir !== null) {
    if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) {
      throw new OtmError("OTM state directory must be absolute.", {
        code: "OTM_STATE_DIR_INVALID",
      });
    }
    runtimeArgs.push("--state-dir", path.resolve(stateDir));
  }
  if (storage !== null) {
    if (!new Set(["auto", "sqlite", "json"]).has(storage)) {
      throw new OtmError("OTM storage must be auto, sqlite, or json.", {
        code: "OTM_STORAGE_INVALID",
      });
    }
    runtimeArgs.push("--storage", storage);
  }
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new OtmError("The configured Node executable does not exist.", {
      code: "CLAUDE_NODE_EXECUTABLE_MISSING",
      details: { executable },
    });
  }
  if (!fs.existsSync(hookScript) || !fs.statSync(hookScript).isFile()) {
    throw new OtmError("The Claude OTM hook entry point does not exist.", {
      code: "CLAUDE_HOOK_SCRIPT_MISSING",
      details: { hookScript },
    });
  }

  const commandHook = (event, timeout, onFailure) => ({
    type: "command",
    command: executable,
    args: [hookScript, ...evidenceArgs, ...runtimeArgs],
    timeout,
    ...(onFailure ? { onFailure } : {}),
    statusMessage: `${MANAGED_STATUS_PREFIX} ${event}`,
  });

  return Object.fromEntries(
    CLAUDE_HOOKS.map(({ event, matcher, timeout, onFailure }) => [
      event,
      [
        {
          ...(matcher ? { matcher } : {}),
          hooks: [commandHook(event, timeout, onFailure)],
        },
      ],
    ]),
  );
}

export function mergeClaudeHookSettings(
  settings,
  {
    packageRoot,
    nodePath = process.execPath,
    hostEvidenceModulePath = null,
    stateDir = null,
    storage = null,
  } = {},
) {
  if (!isRecord(settings)) {
    throw new OtmError("Claude settings must be a JSON object.", {
      code: "CLAUDE_SETTINGS_INVALID",
    });
  }

  const next = structuredClone(settings);
  if (next.hooks !== undefined && !isRecord(next.hooks)) {
    throw new OtmError("Claude settings hooks must be a JSON object.", {
      code: "CLAUDE_HOOKS_INVALID",
    });
  }
  const hooks = { ...(next.hooks || {}) };
  const desired = buildClaudeHookEntries({
    packageRoot,
    nodePath,
    hostEvidenceModulePath,
    stateDir,
    storage,
  });

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      throw new OtmError(`Claude hooks.${event} must be an array.`, {
        code: "CLAUDE_HOOKS_INVALID",
        details: { event },
      });
    }
    hooks[event] = groups
      .map((group) => removeManagedHandlers(group, desired))
      .filter(Boolean);
    if (hooks[event].length === 0) delete hooks[event];
  }

  for (const [event, eventGroups] of Object.entries(desired)) {
    hooks[event] = [...(hooks[event] || []), ...structuredClone(eventGroups)];
  }

  next.hooks = hooks;
  return next;
}

export function installClaudeHooks(options = {}) {
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const settingsPath = resolveClaudeUserSettingsPath({ homeDir });
  const packageRoot = path.resolve(
    options.packageRoot ||
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  const nodePath = options.nodePath || process.execPath;
  const hostEvidenceModulePath = options.hostEvidenceModulePath || null;
  const stateDir = options.stateDir ?? null;
  const storage = options.storage ?? null;
  const dryRun = options.dryRun === true;
  const hookOptions = {
    packageRoot,
    nodePath,
    hostEvidenceModulePath,
    stateDir,
    storage,
  };
  const directory = path.dirname(settingsPath);
  let lock = null;
  let createdBackupPath = null;
  let tempPath = null;
  let originalHash = null;
  let originalExisted = false;
  let stagedHash = null;
  let installedByThisOperation = false;

  try {
    if (!dryRun) lock = acquireLock(`${settingsPath}.otm.lock`);
    const before = readSettingsFile(settingsPath);
    originalHash = before.hash;
    originalExisted = before.exists;
    if (
      options.expectedCurrentHash !== undefined &&
      options.expectedCurrentHash !== before.hash
    ) {
      throw new OtmError(
        "Claude settings changed since the expected revision.",
        {
          code: "CLAUDE_SETTINGS_HASH_MISMATCH",
          details: {
            expectedHash: options.expectedCurrentHash,
            actualHash: before.hash,
          },
        },
      );
    }
    const merged = mergeClaudeHookSettings(before.settings, {
      ...hookOptions,
    });
    const bytes = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8");
    const desiredHash = sha256(bytes);
    stagedHash = desiredHash;
    if (before.hash === desiredHash) {
      return {
        ok: true,
        changed: false,
        dryRun,
        noOp: true,
        settingsPath,
        originalHash: before.hash,
        installedHash: before.hash,
        backupPath: null,
        backupHash: null,
        hookEvents: Object.keys(buildClaudeHookEntries(hookOptions)),
      };
    }
    if (dryRun) {
      return {
        ok: true,
        changed: true,
        dryRun: true,
        noOp: false,
        settingsPath,
        originalHash: before.hash,
        installedHash: desiredHash,
        backupPath: null,
        backupHash: null,
        hookEvents: Object.keys(buildClaudeHookEntries(hookOptions)),
      };
    }

    fs.mkdirSync(directory, { recursive: true });
    const current = readSettingsFile(settingsPath);
    if (current.hash !== before.hash) {
      throw new OtmError(
        "Claude settings changed during installation; no write was made.",
        {
          code: "CLAUDE_SETTINGS_HASH_MISMATCH",
          details: { expectedHash: before.hash, actualHash: current.hash },
        },
      );
    }

    if (before.exists) {
      createdBackupPath = makeBackupPath(settingsPath);
      fs.copyFileSync(
        settingsPath,
        createdBackupPath,
        fs.constants.COPYFILE_EXCL,
      );
      const backupHash = hashFile(createdBackupPath);
      if (backupHash !== before.hash) {
        throw new OtmError(
          "Claude settings backup hash did not match the source.",
          {
            code: "CLAUDE_SETTINGS_BACKUP_HASH_MISMATCH",
            details: { backupPath: createdBackupPath },
          },
        );
      }
    }

    tempPath = path.join(
      directory,
      `.settings.json.otm-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    writeDurableFile(tempPath, bytes, before.mode ?? 0o600);
    if (hashFile(tempPath) !== desiredHash) {
      throw new OtmError(
        "Staged Claude settings hash did not match the merge.",
        {
          code: "CLAUDE_SETTINGS_STAGED_HASH_MISMATCH",
          details: { tempPath },
        },
      );
    }

    const justBeforeRename = readSettingsFile(settingsPath);
    if (justBeforeRename.hash !== before.hash) {
      throw new OtmError(
        "Claude settings changed before commit; no write was made.",
        {
          code: "CLAUDE_SETTINGS_HASH_MISMATCH",
          details: {
            expectedHash: before.hash,
            actualHash: justBeforeRename.hash,
          },
        },
      );
    }
    fs.renameSync(tempPath, settingsPath);
    tempPath = null;
    installedByThisOperation = true;
    const installedHash = hashFile(settingsPath);
    if (installedHash !== desiredHash) {
      throw new OtmError(
        "Installed Claude settings hash did not match the staged file.",
        {
          code: "CLAUDE_SETTINGS_INSTALLED_HASH_MISMATCH",
          details: { expectedHash: desiredHash, actualHash: installedHash },
        },
      );
    }
    return {
      ok: true,
      changed: true,
      dryRun: false,
      noOp: false,
      settingsPath,
      originalHash: before.hash,
      installedHash,
      backupPath: createdBackupPath,
      backupHash: before.exists ? before.hash : null,
      hookEvents: Object.keys(buildClaudeHookEntries(hookOptions)),
    };
  } catch (error) {
    const installedPath = settingsPath;
    const actualHash = fs.existsSync(installedPath)
      ? hashFile(installedPath)
      : null;
    let rolledBack = false;
    let rollbackError = null;
    if (installedByThisOperation && actualHash === stagedHash) {
      try {
        if (originalExisted) {
          if (!createdBackupPath) {
            throw new OtmError("Claude rollback backup is unavailable.", {
              code: "CLAUDE_SETTINGS_BACKUP_MISSING",
            });
          }
          const backupBytes = fs.readFileSync(createdBackupPath);
          if (sha256(backupBytes) !== originalHash) {
            throw new OtmError(
              "Claude rollback backup failed its hash check.",
              {
                code: "CLAUDE_SETTINGS_BACKUP_HASH_MISMATCH",
              },
            );
          }
          const rollbackTemp = path.join(
            directory,
            `.settings.json.otm-rollback-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
          );
          writeDurableFile(rollbackTemp, backupBytes, 0o600);
          fs.renameSync(rollbackTemp, installedPath);
          rolledBack = hashFile(installedPath) === originalHash;
        } else {
          fs.unlinkSync(installedPath);
          rolledBack = !fs.existsSync(installedPath);
        }
      } catch (failure) {
        rollbackError = failure?.message || String(failure);
      }
    }
    return {
      ok: false,
      changed: false,
      dryRun,
      settingsPath,
      code: error?.code || "CLAUDE_SETTINGS_INSTALL_FAILED",
      reason: error?.message || String(error),
      backupPath: createdBackupPath,
      rolledBack,
      rollbackError,
    };
  } finally {
    if (tempPath) removeIfOwned(tempPath);
    if (lock) releaseLock(lock);
  }
}

export function rollbackClaudeHooks({
  homeDir = os.homedir(),
  backupPath,
  backupHash,
  expectedCurrentHash,
  removeCreatedSettings = false,
} = {}) {
  const settingsPath = resolveClaudeUserSettingsPath({ homeDir });
  const directory = path.dirname(settingsPath);
  let lock = null;
  let tempPath = null;
  try {
    if (typeof expectedCurrentHash !== "string" || !expectedCurrentHash) {
      throw new OtmError(
        "expectedCurrentHash is required for Claude rollback.",
        {
          code: "CLAUDE_ROLLBACK_HASH_REQUIRED",
        },
      );
    }
    lock = acquireLock(`${settingsPath}.otm.lock`);
    const current = readSettingsFile(settingsPath);
    if (current.hash !== expectedCurrentHash) {
      throw new OtmError(
        "Claude settings changed after OTM installation; rollback stopped.",
        {
          code: "CLAUDE_SETTINGS_HASH_MISMATCH",
          details: {
            expectedHash: expectedCurrentHash,
            actualHash: current.hash,
          },
        },
      );
    }
    if (!backupPath && removeCreatedSettings === true) {
      if (!current.exists) {
        return {
          ok: true,
          changed: false,
          removedCreatedSettings: false,
          settingsPath,
        };
      }
      fs.unlinkSync(settingsPath);
      return {
        ok: !fs.existsSync(settingsPath),
        changed: !fs.existsSync(settingsPath),
        removedCreatedSettings: !fs.existsSync(settingsPath),
        settingsPath,
        previousHash: current.hash,
      };
    }
    const resolvedBackup = path.resolve(String(backupPath || ""));
    if (
      !backupPath ||
      path.dirname(resolvedBackup) !== directory ||
      !resolvedBackup.startsWith(`${settingsPath}.before-otm-`)
    ) {
      throw new OtmError(
        "Rollback backup must be an OTM backup beside Claude settings.",
        {
          code: "CLAUDE_ROLLBACK_BACKUP_INVALID",
        },
      );
    }
    const backupStat = fs.lstatSync(resolvedBackup);
    if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
      throw new OtmError("Claude rollback backup is not a regular file.", {
        code: "CLAUDE_ROLLBACK_BACKUP_INVALID",
      });
    }
    const bytes = fs.readFileSync(resolvedBackup);
    const actualBackupHash = sha256(bytes);
    if (actualBackupHash !== backupHash) {
      throw new OtmError(
        "Claude rollback backup hash did not match the receipt.",
        {
          code: "CLAUDE_SETTINGS_BACKUP_HASH_MISMATCH",
          details: { expectedHash: backupHash, actualHash: actualBackupHash },
        },
      );
    }
    tempPath = path.join(
      directory,
      `.settings.json.otm-rollback-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    writeDurableFile(tempPath, bytes, backupStat.mode);
    if (hashFile(tempPath) !== actualBackupHash) {
      throw new OtmError(
        "Staged Claude rollback hash did not match the backup.",
        {
          code: "CLAUDE_SETTINGS_STAGED_HASH_MISMATCH",
        },
      );
    }
    fs.renameSync(tempPath, settingsPath);
    tempPath = null;
    const restoredHash = hashFile(settingsPath);
    if (restoredHash !== actualBackupHash) {
      throw new OtmError(
        "Restored Claude settings hash did not match the backup.",
        {
          code: "CLAUDE_SETTINGS_INSTALLED_HASH_MISMATCH",
          details: { expectedHash: actualBackupHash, actualHash: restoredHash },
        },
      );
    }
    return {
      ok: true,
      changed: true,
      settingsPath,
      restoredHash,
      backupPath: resolvedBackup,
    };
  } catch (error) {
    return {
      ok: false,
      changed: false,
      settingsPath,
      code: error?.code || "CLAUDE_SETTINGS_ROLLBACK_FAILED",
      reason: error?.message || String(error),
    };
  } finally {
    if (tempPath) removeIfOwned(tempPath);
    if (lock) releaseLock(lock);
  }
}

function removeManagedHandlers(group, desired) {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return group;
  const managedScriptPaths = new Set(
    Object.values(desired)
      .flat()
      .flatMap((item) => item.hooks)
      .map((handler) => handler.args[0]),
  );
  const remaining = group.hooks.filter(
    (handler) =>
      !(
        isRecord(handler) &&
        handler.type === "command" &&
        typeof handler.statusMessage === "string" &&
        handler.statusMessage.startsWith(MANAGED_STATUS_PREFIX) &&
        managedScriptPaths.has(handler.args?.[0]) &&
        validManagedArgs(handler.args)
      ),
  );
  if (remaining.length === group.hooks.length) return group;
  if (remaining.length === 0) return null;
  return { ...group, hooks: remaining };
}

function validManagedArgs(args) {
  if (!Array.isArray(args) || args.length < 1) return false;
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (typeof option !== "string" || typeof value !== "string") return false;
    if (seen.has(option)) return false;
    seen.add(option);
    if (option === "--host-evidence-module" || option === "--state-dir") {
      if (!path.isAbsolute(value)) return false;
    } else if (
      option === "--storage" &&
      new Set(["auto", "sqlite", "json"]).has(value)
    ) {
      continue;
    } else {
      return false;
    }
  }
  return true;
}

function readSettingsFile(settingsPath) {
  if (!fs.existsSync(settingsPath))
    return { exists: false, settings: {}, hash: null, mode: null };
  const stat = fs.lstatSync(settingsPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new OtmError("Claude settings path must be a regular file.", {
      code: "CLAUDE_SETTINGS_PATH_INVALID",
      details: { settingsPath },
    });
  }
  const bytes = fs.readFileSync(settingsPath);
  let settings;
  try {
    settings = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new OtmError("Claude settings JSON is invalid; no write was made.", {
      code: "CLAUDE_SETTINGS_JSON_INVALID",
    });
  }
  if (!isRecord(settings)) {
    throw new OtmError(
      "Claude settings must contain a top-level JSON object.",
      {
        code: "CLAUDE_SETTINGS_INVALID",
      },
    );
  }
  return {
    exists: true,
    settings,
    hash: sha256(bytes),
    mode: stat.mode,
  };
}

function acquireLock(lockPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new OtmError(
        "Another OTM Claude settings operation holds the lock.",
        {
          code: "CLAUDE_SETTINGS_LOCKED",
          details: { lockPath },
        },
      );
    }
    throw error;
  }
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
      "utf8",
    );
    fs.fsyncSync(descriptor);
    return { descriptor, lockPath };
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } finally {
      removeIfOwned(lockPath);
    }
    throw error;
  }
}

function releaseLock(lock) {
  try {
    fs.closeSync(lock.descriptor);
  } finally {
    removeIfOwned(lock.lockPath);
  }
}

function writeDurableFile(filePath, bytes, mode) {
  const descriptor = fs.openSync(filePath, "wx", mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeIfOwned(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function makeBackupPath(settingsPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${settingsPath}.before-otm-${stamp}-${suffix}.bak`;
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
