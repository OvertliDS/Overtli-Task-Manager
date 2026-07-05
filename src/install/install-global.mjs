import os from 'node:os';
import path from 'node:path';
import { patchHooksJson } from './hook-config.mjs';
import { installRepoSkills } from './skill-install.mjs';

export function installGlobal({ codexHome = null, packageRoot, dryRun = false, env = process.env } = {}) {
  const root = path.resolve(codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const hooks = patchHooksJson({
    workspaceRoot: root,
    packageRoot,
    targetFile: path.join(root, 'hooks.json'),
    dryRun
  });
  const skills = installRepoSkills({
    workspaceRoot: root,
    packageRoot,
    targetRoot: path.join(root, 'skills'),
    dryRun
  });
  return { ok: hooks.ok !== false && skills.ok !== false, codexHome: root, dryRun, results: [{ step: 'hooks', ...hooks }, { step: 'skills', ...skills }] };
}

export function renderGlobalInstallResult(result) {
  const lines = ['## ✅ Overtli Task Manager global install', '', `Codex home: \`${result.codexHome}\``, `Mode: ${result.dryRun ? 'dry run' : 'applied'}`, '', '| Step | Result | Path |', '|---|---|---|'];
  for (const item of result.results) {
    const status = item.ok === false ? `⚠ ${item.reason || item.action || 'needs attention'}` : `✅ ${item.action || 'ok'}`;
    const target = item.filePath || (item.installed ? `${item.installed.length} skill(s)` : '—');
    lines.push(`| ${item.step} | ${status} | ${target} |`);
  }
  lines.push('', 'Restart Codex or reload the workspace so global hooks and skills are rediscovered.');
  return `${lines.join('\n')}\n`;
}
