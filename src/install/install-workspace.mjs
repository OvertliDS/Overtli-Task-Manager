import fs from "node:fs";
import path from "node:path";
import {
  findWorkspaceRoot,
  ensureDir,
  workspaceStateDir,
  workspaceTempDir,
  atomicWriteJson,
  readJson,
  hashFile,
} from "../core/fs-utils.mjs";
import { patchAgentsFile } from "./agent-block.mjs";
import { patchHooksJson } from "./hook-config.mjs";
import { installRepoSkills } from "./skill-install.mjs";
import { patchGitignore } from "./gitignore.mjs";
import { patchProjectMcpConfig } from "./mcp-config.mjs";
import { resolveWithinRoot } from "../core/validation.mjs";

/** @param {any} options */
export function installWorkspace(options = {}) {
  const {
    cwd = process.cwd(),
    workspaceRoot = null,
    packageRoot,
    dryRun = false,
    installMcpConfig = false,
    targetAgentsFile = null,
  } = options;
  const root = path.resolve(workspaceRoot || findWorkspaceRoot(cwd));
  if (targetAgentsFile) resolveWithinRoot(root, targetAgentsFile);
  const steps = () => [
    {
      step: "agents",
      run: (preview) =>
        patchAgentsFile({
          workspaceRoot: root,
          targetFile: targetAgentsFile,
          dryRun: preview,
        }),
    },
    {
      step: "hooks",
      run: (preview) =>
        patchHooksJson({ workspaceRoot: root, packageRoot, dryRun: preview }),
    },
    {
      step: "skills",
      run: (preview) =>
        installRepoSkills({
          workspaceRoot: root,
          packageRoot,
          dryRun: preview,
        }),
    },
    {
      step: "gitignore",
      run: (preview) =>
        patchGitignore({ workspaceRoot: root, dryRun: preview }),
    },
    ...(installMcpConfig
      ? [
          {
            step: "mcp-config",
            run: (preview) =>
              patchProjectMcpConfig({
                workspaceRoot: root,
                packageRoot,
                dryRun: preview,
              }),
          },
        ]
      : []),
  ];
  // Complete read-only preflight comes before every write. A malformed config
  // or marker conflict cannot leave a partially installed workspace behind.
  const preflight = steps().map((item) => ({
    step: item.step,
    ...item.run(true),
  }));
  if (dryRun || preflight.some((item) => item.ok === false)) {
    const manifest = buildInstallManifest({
      root,
      packageRoot,
      dryRun: true,
      results: preflight,
    });
    return {
      ok: preflight.every((r) => r.ok !== false),
      workspaceRoot: root,
      dryRun: true,
      manifest,
      results: preflight,
    };
  }
  const affectedPaths = managedPaths(preflight);
  const originals = snapshotFiles(affectedPaths);
  const transactionId = `install-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const backupPath = path.join(
    workspaceStateDir(root),
    "install-backups",
    transactionId,
  );
  try {
    ensureDir(backupPath);
    writeBackups(backupPath, root, originals);
    const results = [];
    for (const item of steps()) {
      const result = { step: item.step, ...item.run(false) };
      results.push(result);
      if (result.ok === false) {
        const failed = /** @type {any} */ (result);
        throw new Error(
          `${item.step}: ${failed.reason || failed.action || "installation failed"}`,
        );
      }
    }
    const manifest = buildInstallManifest({
      root,
      packageRoot,
      dryRun,
      results,
      transactionId,
      backupPath,
      before: originals,
    });
    atomicWriteJson(
      path.join(workspaceStateDir(root), "install.json"),
      manifest,
      { tempDir: workspaceTempDir(root) },
    );
    return {
      ok: true,
      workspaceRoot: root,
      dryRun,
      manifest,
      backupPath,
      results,
    };
  } catch (error) {
    restoreFiles(originals, root);
    return {
      ok: false,
      workspaceRoot: root,
      dryRun: false,
      rolledBack: true,
      backupPath,
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

function managedPaths(results) {
  return [
    ...new Set(
      results
        .flatMap((item) => [
          item.filePath,
          ...(Array.isArray(item.installed)
            ? item.installed.flatMap((skill) => skill.files || [skill.path])
            : []),
        ])
        .filter(Boolean)
        .map((item) => path.resolve(item)),
    ),
  ];
}

function snapshotFiles(paths) {
  return paths.map((filePath) => {
    const existed = fs.existsSync(filePath);
    const stat = existed ? fs.statSync(filePath) : null;
    const isFile = Boolean(stat?.isFile());
    return {
      filePath,
      existed,
      isFile,
      content: isFile ? fs.readFileSync(filePath) : null,
      mode: isFile ? stat.mode : null,
      beforeHash: isFile ? hashFile(filePath) : null,
    };
  });
}

function writeBackups(backupPath, root, originals) {
  const manifest = originals.map((item, index) => ({
    filePath: item.filePath,
    existed: item.existed,
    isFile: item.isFile,
    beforeHash: item.beforeHash,
    backupFile: item.isFile ? `${index}.bak` : null,
  }));
  for (const [index, item] of originals.entries())
    if (item.isFile)
      fs.writeFileSync(path.join(backupPath, `${index}.bak`), item.content, {
        mode: item.mode,
      });
  fs.writeFileSync(
    path.join(backupPath, "manifest.json"),
    `${JSON.stringify({ schemaVersion: "otm.install-backup.v1", workspaceRoot: root, files: manifest }, null, 2)}\n`,
    "utf8",
  );
}

function restoreFiles(originals, root) {
  for (const item of originals) {
    if (item.isFile) {
      ensureDir(path.dirname(item.filePath));
      fs.writeFileSync(item.filePath, item.content, { mode: item.mode });
    } else if (!item.existed) {
      try {
        fs.rmSync(item.filePath, { force: true });
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

function buildInstallManifest({
  root,
  packageRoot,
  dryRun,
  results,
  transactionId = null,
  backupPath = null,
  before = [],
}) {
  const packageJson = readJson(path.join(packageRoot, "package.json"), {});
  return {
    schemaVersion: "otm.install.v2",
    manager: "Overtli Task Manager",
    packageName: packageJson.name || "@overtli/task-manager",
    packageVersion: packageJson.version || "0.0.0",
    workspaceRoot: root,
    packageRoot,
    dryRun,
    transactionId,
    backupPath,
    installedAt: new Date().toISOString(),
    steps: results.map((item) => ({
      step: item.step,
      ok: item.ok !== false,
      action: item.action || (item.changed ? "updated" : "unchanged"),
      filePath: item.filePath || null,
      changed: Boolean(item.changed),
      warning: item.warning || null,
      beforeHash:
        before.find((file) => file.filePath === item.filePath)?.beforeHash ||
        null,
      afterHash: item.filePath ? hashFile(item.filePath) : null,
      ownedFiles: Array.isArray(item.installed)
        ? item.installed.flatMap((skill) =>
            (skill.files || [skill.path]).map((filePath) => ({
              skill: skill.name,
              path: filePath,
              afterHash: hashFile(filePath),
            })),
          )
        : [],
    })),
  };
}

export function renderInstallResult(result) {
  const lines = [];
  lines.push("## ✅ Overtli Task Manager install");
  lines.push("");
  lines.push(`Workspace: \`${result.workspaceRoot}\``);
  lines.push(`Mode: ${result.dryRun ? "dry run" : "applied"}`);
  lines.push("");
  lines.push("| Step | Result | Path |");
  lines.push("|---|---|---|");
  for (const item of result.results) {
    const status =
      item.ok === false
        ? `⚠ ${item.reason || item.action || "needs attention"}`
        : `✅ ${item.action || "ok"}${item.warning ? `; warning: ${item.warning}` : ""}`;
    const file =
      item.filePath ||
      (item.installed ? `${item.installed.length} skill(s)` : "—");
    lines.push(`| ${item.step} | ${status} | ${file} |`);
  }
  lines.push("");
  lines.push(
    "Next: restart Codex or reload the workspace if newly installed skills/hooks do not appear immediately. Project hooks may require trust review before they execute.",
  );
  return `${lines.join("\n")}\n`;
}
