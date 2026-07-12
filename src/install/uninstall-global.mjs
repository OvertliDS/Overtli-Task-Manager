import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  atomicWriteText,
  ensureDir,
  hashFile,
  readText,
} from "../core/fs-utils.mjs";
import { removeOtmHooksDocument } from "./hook-config.mjs";

/** Remove only globally installed OTM hooks and unmodified packaged skills. */
/** @param {any} options */
export function uninstallGlobal(options = {}) {
  const {
    codexHome = null,
    packageRoot,
    dryRun = false,
    confirm = false,
    env = process.env,
  } = options;
  const root = path.resolve(
    codexHome || env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  );
  if (!dryRun && !confirm) return confirmationRequired(root);
  const plans = [
    hooksPlan(path.join(root, "hooks.json")),
    skillsPlan(root, packageRoot),
  ];
  const preflight = plans.map((plan) => plan.preview());
  if (dryRun || preflight.some((result) => result.ok === false))
    return {
      ok: preflight.every((result) => result.ok !== false),
      codexHome: root,
      dryRun: true,
      results: preflight,
    };

  const originals = snapshotPaths(
    preflight.flatMap((result) => result.affectedPaths || []),
  );
  const transactionId = `global-uninstall-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const backupPath = path.join(
    root,
    "overtli-task-manager-backups",
    transactionId,
  );
  try {
    ensureDir(backupPath);
    writeBackups(backupPath, root, originals);
    const results = [];
    for (const plan of plans) {
      const result = plan.apply();
      results.push(result);
      if (result.ok === false) {
        const failed = /** @type {any} */ (result);
        throw new Error(
          `${plan.step}: ${failed.reason || failed.action || "uninstall failed"}`,
        );
      }
    }
    const manifest = {
      schemaVersion: "otm.global-uninstall.v1",
      codexHome: root,
      packageRoot,
      transactionId,
      backupPath,
      completedAt: new Date().toISOString(),
      steps: results.map((result) => {
        const item = /** @type {any} */ (result);
        return {
          step: result.step,
          action: result.action,
          changed: Boolean(result.changed),
          filePath: item.filePath || null,
        };
      }),
    };
    atomicWriteJson(path.join(backupPath, "uninstall.json"), manifest, {
      tempDir: backupPath,
    });
    return {
      ok: true,
      codexHome: root,
      dryRun: false,
      backupPath,
      manifest,
      results,
    };
  } catch (error) {
    restorePaths(originals, root);
    return {
      ok: false,
      codexHome: root,
      dryRun: false,
      backupPath,
      rolledBack: true,
      results: [
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

function confirmationRequired(codexHome) {
  return {
    ok: false,
    codexHome,
    dryRun: false,
    results: [
      {
        step: "confirmation",
        ok: false,
        action: "confirmation-required",
        reason:
          "Global uninstall requires --confirm after reviewing a dry-run preview.",
      },
    ],
  };
}

function hooksPlan(filePath) {
  const build = () => {
    const before = readText(filePath, "");
    if (!before.trim())
      return {
        ok: true,
        action: "unchanged",
        changed: false,
        after: before,
        removed: [],
      };
    let document;
    try {
      document = JSON.parse(before);
    } catch {
      return {
        ok: false,
        action: "invalid-json",
        reason: "Global hooks.json is malformed. Uninstall was not applied.",
      };
    }
    try {
      const { doc, removed } = removeOtmHooksDocument(document);
      const after = `${JSON.stringify(doc, null, 2)}\n`;
      return {
        ok: true,
        action: removed.length ? "removed" : "unchanged",
        changed: after !== before,
        after,
        removed,
      };
    } catch (error) {
      return {
        ok: false,
        action: "invalid-json",
        reason: String(error.message || error),
      };
    }
  };
  return {
    step: "hooks",
    preview: () => ({
      step: "hooks",
      filePath,
      affectedPaths: [filePath],
      ...build(),
      dryRun: true,
    }),
    apply: () => {
      const result = build();
      if (result.ok && result.changed) atomicWriteText(filePath, result.after);
      return {
        step: "hooks",
        filePath,
        affectedPaths: [filePath],
        ...result,
        dryRun: false,
      };
    },
  };
}

function skillsPlan(root, packageRoot) {
  const sourceRoot = path.join(packageRoot, "skills");
  const targetRoot = path.join(root, "skills");
  const build = () => {
    const installed = [];
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !fs.existsSync(path.join(sourceRoot, entry.name, "SKILL.md"))
      )
        continue;
      const sourceDir = path.join(sourceRoot, entry.name);
      const targetDir = path.join(targetRoot, entry.name);
      if (!fs.existsSync(targetDir))
        installed.push({
          name: entry.name,
          path: targetDir,
          action: "unchanged",
          removable: false,
        });
      else if (matchesPackagedSkill(sourceDir, targetDir))
        installed.push({
          name: entry.name,
          path: targetDir,
          action: "removed",
          removable: true,
        });
      else
        installed.push({
          name: entry.name,
          path: targetDir,
          action: "skipped-ownership-mismatch",
          removable: false,
          warning: "Skill contains changes or extra files and was preserved.",
        });
    }
    const removable = installed.filter((skill) => skill.removable);
    return {
      ok: true,
      action: removable.length ? `${removable.length} removed` : "unchanged",
      changed: removable.length > 0,
      installed,
      affectedPaths: removable.map((skill) => skill.path),
    };
  };
  return {
    step: "skills",
    preview: () => ({ step: "skills", ...build(), dryRun: true }),
    apply: () => {
      const result = build();
      for (const skill of result.installed.filter((item) => item.removable))
        fs.rmSync(skill.path, { recursive: true, force: false });
      pruneEmptyParents(targetRoot, root);
      return { step: "skills", ...result, dryRun: false };
    },
  };
}

function matchesPackagedSkill(sourceDir, targetDir) {
  const sourceFiles = listFiles(sourceDir);
  const targetFiles = listFiles(targetDir);
  return (
    sourceFiles.length === targetFiles.length &&
    sourceFiles.every(
      (file, index) =>
        file === targetFiles[index] &&
        hashFile(path.join(sourceDir, file)) ===
          hashFile(path.join(targetDir, file)),
    )
  );
}

function listFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory())
      files.push(
        ...listFiles(filePath).map((child) => path.join(entry.name, child)),
      );
    else if (entry.isFile()) files.push(entry.name);
    else return ["__unsupported_entry__"];
  }
  return files.sort();
}

function snapshotPaths(paths) {
  return [...new Set(paths)].map((filePath) => {
    const exists = fs.existsSync(filePath);
    const stat = exists ? fs.statSync(filePath) : null;
    return {
      filePath,
      exists,
      isFile: Boolean(stat?.isFile()),
      isDirectory: Boolean(stat?.isDirectory()),
      content: stat?.isFile() ? fs.readFileSync(filePath) : null,
      mode: stat?.isFile() ? stat.mode : null,
    };
  });
}

function writeBackups(backupPath, root, originals) {
  const files = originals.map((item, index) => ({
    filePath: item.filePath,
    existed: item.exists,
    isFile: item.isFile,
    isDirectory: item.isDirectory,
    beforeHash: item.isFile ? hashFile(item.filePath) : null,
    backupFile: item.isFile
      ? `${index}.bak`
      : item.isDirectory
        ? `${index}.dir`
        : null,
  }));
  for (const [index, item] of originals.entries())
    if (item.isFile)
      fs.writeFileSync(path.join(backupPath, `${index}.bak`), item.content, {
        mode: item.mode,
      });
  for (const [index, item] of originals.entries())
    if (item.isDirectory) {
      fs.cpSync(item.filePath, path.join(backupPath, `${index}.dir`), {
        recursive: true,
        force: true,
      });
      item.backupPath = backupPath;
    }
  fs.writeFileSync(
    path.join(backupPath, "manifest.json"),
    `${JSON.stringify({ schemaVersion: "otm.global-uninstall-backup.v1", codexHome: root, files }, null, 2)}\n`,
    "utf8",
  );
}

function restorePaths(originals, root) {
  for (const item of originals) {
    if (item.isFile) {
      ensureDir(path.dirname(item.filePath));
      fs.writeFileSync(item.filePath, item.content, { mode: item.mode });
    } else if (item.isDirectory) {
      try {
        fs.rmSync(item.filePath, { recursive: true, force: true });
      } catch {}
      const index = originals.indexOf(item);
      if (item.backupPath)
        fs.cpSync(path.join(item.backupPath, `${index}.dir`), item.filePath, {
          recursive: true,
          force: true,
        });
    } else if (!item.exists) {
      try {
        fs.rmSync(item.filePath, { recursive: true, force: true });
      } catch {}
      pruneEmptyParents(path.dirname(item.filePath), root);
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

export function renderGlobalUninstallResult(result) {
  const lines = [
    "## Overtli Task Manager global uninstall",
    "",
    `Codex home: \`${result.codexHome}\``,
    `Mode: ${result.dryRun ? "dry run" : "applied"}`,
    "",
    "| Step | Result | Path |",
    "|---|---|---|",
  ];
  for (const item of result.results)
    lines.push(
      `| ${item.step} | ${item.ok === false ? `warning: ${item.reason || item.action}` : item.action || "unchanged"} | ${item.filePath || (item.installed ? `${item.installed.length} skill(s)` : "—")} |`,
    );
  if (result.backupPath) lines.push("", `Backup: \`${result.backupPath}\``);
  lines.push(
    "",
    "Only OTM-owned hooks and unmodified packaged skill directories were removed.",
  );
  return `${lines.join("\n")}\n`;
}
