import path from 'node:path';
import { findWorkspaceRoot, ensureDir, workspaceStateDir, atomicWriteJson, readJson } from '../core/fs-utils.mjs';
import { patchAgentsFile } from './agent-block.mjs';
import { patchHooksJson } from './hook-config.mjs';
import { installRepoSkills } from './skill-install.mjs';
import { patchGitignore } from './gitignore.mjs';
import { patchProjectMcpConfig } from './mcp-config.mjs';

export function installWorkspace({ cwd = process.cwd(), workspaceRoot = null, packageRoot, dryRun = false, installMcpConfig = false, targetAgentsFile = null } = {}) {
  const root = path.resolve(workspaceRoot || findWorkspaceRoot(cwd));
  ensureDir(workspaceStateDir(root));
  const results = [];
  results.push({ step: 'agents', ...patchAgentsFile({ workspaceRoot: root, targetFile: targetAgentsFile, dryRun }) });
  results.push({ step: 'hooks', ...patchHooksJson({ workspaceRoot: root, packageRoot, dryRun }) });
  results.push({ step: 'skills', ...installRepoSkills({ workspaceRoot: root, packageRoot, dryRun }) });
  results.push({ step: 'gitignore', ...patchGitignore({ workspaceRoot: root, dryRun }) });
  if (installMcpConfig) results.push({ step: 'mcp-config', ...patchProjectMcpConfig({ workspaceRoot: root, packageRoot, dryRun }) });
  const manifest = buildInstallManifest({ root, packageRoot, dryRun, results });
  if (!dryRun) atomicWriteJson(path.join(workspaceStateDir(root), 'install.json'), manifest);
  return { ok: results.every((r) => r.ok !== false), workspaceRoot: root, dryRun, manifest, results };
}


function buildInstallManifest({ root, packageRoot, dryRun, results }) {
  const packageJson = readJson(path.join(packageRoot, 'package.json'), {});
  return {
    schemaVersion: 'otm.install.v1',
    manager: 'Overtli Task Manager',
    packageName: packageJson.name || '@overtli/task-manager',
    packageVersion: packageJson.version || '0.0.0',
    workspaceRoot: root,
    packageRoot,
    dryRun,
    installedAt: new Date().toISOString(),
    steps: results.map((item) => ({
      step: item.step,
      ok: item.ok !== false,
      action: item.action || (item.changed ? 'updated' : 'unchanged'),
      filePath: item.filePath || null,
      changed: Boolean(item.changed)
    }))
  };
}

export function renderInstallResult(result) {
  const lines = [];
  lines.push('## ✅ Overtli Task Manager install');
  lines.push('');
  lines.push(`Workspace: \`${result.workspaceRoot}\``);
  lines.push(`Mode: ${result.dryRun ? 'dry run' : 'applied'}`);
  lines.push('');
  lines.push('| Step | Result | Path |');
  lines.push('|---|---|---|');
  for (const item of result.results) {
    const status = item.ok === false ? `⚠ ${item.reason || item.action || 'needs attention'}` : `✅ ${item.action || 'ok'}`;
    const file = item.filePath || (item.installed ? `${item.installed.length} skill(s)` : '—');
    lines.push(`| ${item.step} | ${status} | ${file} |`);
  }
  lines.push('');
  lines.push('Next: restart Codex or reload the workspace if newly installed skills/hooks do not appear immediately. Project hooks may require trust review before they execute.');
  return `${lines.join('\n')}\n`;
}
