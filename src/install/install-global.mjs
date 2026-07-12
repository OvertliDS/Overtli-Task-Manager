import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchHooksJson } from "./hook-config.mjs";
import { installRepoSkills } from "./skill-install.mjs";
import { atomicWriteJson, ensureDir, hashFile } from "../core/fs-utils.mjs";

/** @param {any} options */
export function installGlobal(options = {}) {
  const {
    codexHome = null,
    packageRoot,
    dryRun = false,
    env = process.env,
    now = () => new Date(),
  } = options;
  const root = path.resolve(
    codexHome || env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  );
  const hooksFile = path.join(root, "hooks.json");
  const hooksPreview = patchHooksJson({
    workspaceRoot: root,
    packageRoot,
    targetFile: hooksFile,
    dryRun: true,
  });
  const skillsPreview = installRepoSkills({
    workspaceRoot: root,
    packageRoot,
    targetRoot: path.join(root, "skills"),
    dryRun: true,
  });
  if (dryRun || hooksPreview.ok === false || skillsPreview.ok === false) {
    return {
      ok: hooksPreview.ok !== false && skillsPreview.ok !== false,
      codexHome: root,
      dryRun: true,
      backupPath: null,
      results: [
        { step: "hooks", ...hooksPreview },
        { step: "skills", ...skillsPreview },
      ],
    };
  }
  const originals = snapshotFiles([
    hooksFile,
    ...skillsPreview.installed.flatMap((item) => item.files || [item.path]),
  ]);
  const transactionId = `global-install-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const transactionBackupPath = path.join(
    root,
    "overtli-task-manager-backups",
    transactionId,
  );
  let backupPath = null;
  if (hooksPreview.changed && fs.existsSync(hooksFile)) {
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(root, `hooks.json.before-otm-global-${stamp}.bak`);
    fs.copyFileSync(hooksFile, backupPath, fs.constants.COPYFILE_EXCL);
  }
  const results = [];
  try {
    ensureDir(transactionBackupPath);
    writeTransactionBackups(transactionBackupPath, root, originals);
    const hooks = patchHooksJson({
      workspaceRoot: root,
      packageRoot,
      targetFile: hooksFile,
    });
    results.push({ step: "hooks", ...hooks });
    if (hooks.ok === false)
      throw new Error(hooks.reason || "Global hook installation failed.");
    const skills = installRepoSkills({
      workspaceRoot: root,
      packageRoot,
      targetRoot: path.join(root, "skills"),
      dryRun: false,
    });
    results.push({ step: "skills", ...skills });
    if (skills.ok === false)
      throw new Error(skills.reason || "Global skill installation failed.");
    const manifest = {
      schemaVersion: "otm.global-install.v1",
      codexHome: root,
      packageRoot,
      transactionId,
      backupPath: transactionBackupPath,
      installedAt: new Date().toISOString(),
      steps: results.map((result) => {
        const item = /** @type {any} */ (result);
        return {
          step: result.step,
          action: result.action,
          changed: Boolean(result.changed),
          filePath: item.filePath || null,
          ownedFiles: Array.isArray(item.installed)
            ? item.installed.flatMap((skill) =>
                (skill.files || [skill.path]).map((filePath) => ({
                  skill: skill.name,
                  path: filePath,
                  afterHash: hashFile(filePath),
                })),
              )
            : [],
        };
      }),
    };
    atomicWriteJson(
      path.join(transactionBackupPath, "install.json"),
      manifest,
      { tempDir: transactionBackupPath },
    );
    return {
      ok: true,
      codexHome: root,
      dryRun,
      backupPath,
      transactionBackupPath,
      manifest,
      results,
    };
  } catch (error) {
    restoreFiles(originals, root);
    return {
      ok: false,
      codexHome: root,
      dryRun: false,
      backupPath,
      transactionBackupPath,
      rolledBack: true,
      results: [
        ...results,
        {
          step: "transaction",
          ok: false,
          action: "rolled-back",
          reason: String(error.message || error),
        },
      ],
    };
  }
}

function writeTransactionBackups(backupPath, root, originals) {
  const files = originals.map((item, index) => ({
    filePath: item.filePath,
    existed: item.exists,
    isFile: item.isFile,
    beforeHash: item.isFile ? hashFile(item.filePath) : null,
    backupFile: item.isFile ? `${index}.bak` : null,
  }));
  for (const [index, item] of originals.entries())
    if (item.isFile)
      fs.writeFileSync(path.join(backupPath, `${index}.bak`), item.content, {
        mode: item.mode,
      });
  fs.writeFileSync(
    path.join(backupPath, "manifest.json"),
    `${JSON.stringify({ schemaVersion: "otm.global-install-backup.v1", codexHome: root, files }, null, 2)}\n`,
    "utf8",
  );
}

function snapshotFiles(paths) {
  return paths.map((filePath) => {
    const exists = fs.existsSync(filePath);
    const stat = exists ? fs.statSync(filePath) : null;
    return {
      filePath,
      exists,
      isFile: Boolean(stat?.isFile()),
      content: stat?.isFile() ? fs.readFileSync(filePath) : null,
      mode: stat?.isFile() ? stat.mode : null,
    };
  });
}

function restoreFiles(files, root) {
  for (const file of files) {
    if (file.isFile) {
      fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
      fs.writeFileSync(file.filePath, file.content, { mode: file.mode });
    } else if (!file.exists) {
      try {
        fs.rmSync(file.filePath, { force: true });
      } catch {}
      pruneEmptyParents(path.dirname(file.filePath), root);
    }
  }
}

function pruneEmptyParents(dir, root) {
  let current = dir;
  while (current.startsWith(root) && current !== root) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export function renderGlobalInstallResult(result) {
  const lines = [
    "## ✅ Overtli Task Manager global install",
    "",
    `Codex home: \`${result.codexHome}\``,
    `Mode: ${result.dryRun ? "dry run" : "applied"}`,
    "",
    "| Step | Result | Path |",
    "|---|---|---|",
  ];
  for (const item of result.results) {
    const status =
      item.ok === false
        ? `⚠ ${item.reason || item.action || "needs attention"}`
        : `✅ ${item.action || "ok"}`;
    const target =
      item.filePath ||
      (item.installed ? `${item.installed.length} skill(s)` : "—");
    lines.push(`| ${item.step} | ${status} | ${target} |`);
  }
  if (result.backupPath)
    lines.push("", `Hooks backup: \`${result.backupPath}\``);
  lines.push(
    "",
    "Restart Codex or reload the workspace so global hooks and skills are rediscovered.",
  );
  return `${lines.join("\n")}\n`;
}
