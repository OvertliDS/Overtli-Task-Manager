import fs from "node:fs";
import path from "node:path";
import { atomicWriteText, readText } from "../core/fs-utils.mjs";

/** @param {any} options */
export function installRepoSkills(options = {}) {
  const {
    workspaceRoot,
    packageRoot,
    targetRoot = null,
    dryRun = false,
  } = options;
  const source = path.join(packageRoot, "skills");
  const skillRoot = targetRoot
    ? path.resolve(targetRoot)
    : path.join(workspaceRoot, ".agents", "skills");
  const installed = [];
  for (const skillName of fs.readdirSync(source)) {
    const srcSkill = path.join(source, skillName, "SKILL.md");
    if (!fs.existsSync(srcSkill)) continue;
    const targetSkillDir = path.join(skillRoot, skillName);
    const targetSkill = path.join(targetSkillDir, "SKILL.md");
    const files = listSkillFiles(path.join(source, skillName));
    let changed = false;
    const targetFiles = [];
    for (const relative of files) {
      const sourceFile = path.join(source, skillName, relative);
      const targetFile = path.join(targetSkillDir, relative);
      const content = readText(sourceFile, "");
      const existing = readText(targetFile, null);
      if (existing !== content) {
        changed = true;
        if (!dryRun) {
          fs.mkdirSync(path.dirname(targetFile), { recursive: true });
          atomicWriteText(targetFile, content);
        }
      }
      targetFiles.push(targetFile);
    }
    installed.push({
      name: skillName,
      path: targetSkill,
      directory: targetSkillDir,
      files: targetFiles,
      changed,
    });
  }
  const changedCount = installed.filter((item) => item.changed).length;
  return {
    ok: true,
    dryRun,
    action: changedCount ? `${changedCount} updated` : "unchanged",
    installed,
    changed: changedCount > 0,
  };
}

function listSkillFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory())
      files.push(
        ...listSkillFiles(fullPath).map((child) =>
          path.join(entry.name, child),
        ),
      );
    else if (entry.isFile()) files.push(entry.name);
  }
  return files.sort();
}
