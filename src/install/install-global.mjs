import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchHooksJson } from './hook-config.mjs';
import { installRepoSkills } from './skill-install.mjs';

export function installGlobal({ codexHome = null, packageRoot, dryRun = false, env = process.env, now = () => new Date() } = {}) {
  const root = path.resolve(codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const hooksFile = path.join(root, 'hooks.json');
  const hooksPreview = patchHooksJson({
    workspaceRoot: root,
    packageRoot,
    targetFile: hooksFile,
    dryRun: true
  });
  let backupPath = null;
  if (!dryRun && hooksPreview.changed && fs.existsSync(hooksFile)) {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(root, `hooks.json.before-otm-global-${stamp}.bak`);
    fs.copyFileSync(hooksFile, backupPath, fs.constants.COPYFILE_EXCL);
  }
  const hooks = dryRun ? hooksPreview : patchHooksJson({ workspaceRoot: root, packageRoot, targetFile: hooksFile });
  const skills = installRepoSkills({
    workspaceRoot: root,
    packageRoot,
    targetRoot: path.join(root, 'skills'),
    dryRun
  });
  return { ok: hooks.ok !== false && skills.ok !== false, codexHome: root, dryRun, backupPath, results: [{ step: 'hooks', ...hooks }, { step: 'skills', ...skills }] };
}

export function renderGlobalInstallResult(result) {
  const lines = ['## ✅ Overtli Task Manager global install', '', `Codex home: \`${result.codexHome}\``, `Mode: ${result.dryRun ? 'dry run' : 'applied'}`, '', '| Step | Result | Path |', '|---|---|---|'];
  for (const item of result.results) {
    const status = item.ok === false ? `⚠ ${item.reason || item.action || 'needs attention'}` : `✅ ${item.action || 'ok'}`;
    const target = item.filePath || (item.installed ? `${item.installed.length} skill(s)` : '—');
    lines.push(`| ${item.step} | ${status} | ${target} |`);
  }
  if (result.backupPath) lines.push('', `Hooks backup: \`${result.backupPath}\``);
  lines.push('', 'Restart Codex or reload the workspace so global hooks and skills are rediscovered.');
  return `${lines.join('\n')}\n`;
}
