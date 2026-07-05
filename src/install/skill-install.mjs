import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteText, readText } from '../core/fs-utils.mjs';

export function installRepoSkills({ workspaceRoot, packageRoot, targetRoot = null, dryRun = false } = {}) {
  const source = path.join(packageRoot, 'skills');
  const skillRoot = targetRoot ? path.resolve(targetRoot) : path.join(workspaceRoot, '.agents', 'skills');
  const installed = [];
  for (const skillName of fs.readdirSync(source)) {
    const srcSkill = path.join(source, skillName, 'SKILL.md');
    if (!fs.existsSync(srcSkill)) continue;
    const targetSkillDir = path.join(skillRoot, skillName);
    const targetSkill = path.join(targetSkillDir, 'SKILL.md');
    const content = readText(srcSkill, '');
    const existing = readText(targetSkill, null);
    const changed = existing !== content;
    if (!dryRun && changed) {
      fs.mkdirSync(targetSkillDir, { recursive: true });
      atomicWriteText(targetSkill, content);
    }
    installed.push({ name: skillName, path: targetSkill, changed });
  }
  const changedCount = installed.filter((item) => item.changed).length;
  return { ok: true, dryRun, action: changedCount ? `${changedCount} updated` : 'unchanged', installed, changed: changedCount > 0 };
}
