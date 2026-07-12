import fs from 'node:fs';
import path from 'node:path';
import { findWorkspaceRoot, ensureDir, workspaceStateDir, workspaceTempDir, atomicWriteJson, atomicWriteText, hashFile, readText } from '../core/fs-utils.mjs';
import { AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END, MCP_BLOCK_BEGIN, MCP_BLOCK_END } from '../core/constants.mjs';
import { removeOtmHooksDocument } from './hook-config.mjs';
import { resolveWithinRoot } from '../core/validation.mjs';

const GITIGNORE_BLOCK_BEGIN = '# OVERTLI-TASK-MANAGER:GITIGNORE:BEGIN v1';
const GITIGNORE_BLOCK_END = '# OVERTLI-TASK-MANAGER:GITIGNORE:END';

/** Remove only content that OTM can prove it owns in one workspace. */
export function uninstallWorkspace({ cwd = process.cwd(), workspaceRoot = null, packageRoot, dryRun = false, confirm = false, removeState = false, targetAgentsFile = null } = {}) {
  const root = path.resolve(workspaceRoot || findWorkspaceRoot(cwd));
  if (targetAgentsFile) resolveWithinRoot(root, targetAgentsFile);
  if (!dryRun && !confirm) return { ok: false, workspaceRoot: root, dryRun: false, results: [{ step: 'confirmation', ok: false, action: 'confirmation-required', reason: 'Uninstall requires --confirm after reviewing a dry-run preview.' }] };

  const plans = buildPlans({ root, packageRoot, removeState, targetAgentsFile });
  const preflight = plans.map((plan) => plan.preview());
  if (dryRun || preflight.some((result) => result.ok === false)) return { ok: preflight.every((result) => result.ok !== false), workspaceRoot: root, dryRun: true, results: preflight };

  const originals = snapshotPaths(preflight.flatMap((item) => item.affectedPaths || []).filter(Boolean));
  const transactionId = `uninstall-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // When state removal is requested, backups must live outside the state tree
  // being removed; otherwise a successful uninstall would erase its recovery
  // material before it could be reported.
  const backupPath = removeState
    ? path.join(root, '.codex', 'overtli-task-manager-backups', transactionId)
    : path.join(workspaceStateDir(root), 'install-backups', transactionId);
  try {
    ensureDir(backupPath);
    writeBackups(backupPath, root, originals);
    const results = [];
    for (const plan of plans) {
      const result = plan.apply();
      results.push(result);
      if (result.ok === false) throw new Error(`${plan.step}: ${result.reason || result.action || 'uninstall failed'}`);
    }
    const manifest = { schemaVersion: 'otm.uninstall.v1', workspaceRoot: root, packageRoot, removeState, transactionId, backupPath, completedAt: new Date().toISOString(), steps: results.map((result) => ({ step: result.step, action: result.action, changed: Boolean(result.changed), filePath: result.filePath || null })) };
    atomicWriteJson(path.join(backupPath, 'uninstall.json'), manifest, { tempDir: backupPath });
    return { ok: true, workspaceRoot: root, dryRun: false, backupPath, manifest, results };
  } catch (error) {
    restorePaths(originals, root);
    return { ok: false, workspaceRoot: root, dryRun: false, backupPath, rolledBack: true, results: [{ step: 'transaction', ok: false, action: 'rolled-back', reason: String(error.message || error) }] };
  }
}

function buildPlans({ root, packageRoot, removeState, targetAgentsFile }) {
  const agents = targetAgentsFile ? resolveWithinRoot(root, targetAgentsFile) : path.join(root, 'AGENTS.md');
  return [
    markerPlan('agents', agents, AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END),
    hooksPlan(path.join(root, '.codex', 'hooks.json')),
    skillPlan(root, packageRoot),
    markerPlan('gitignore', path.join(root, '.gitignore'), GITIGNORE_BLOCK_BEGIN, GITIGNORE_BLOCK_END),
    markerPlan('mcp-config', path.join(root, '.codex', 'config.toml'), MCP_BLOCK_BEGIN, MCP_BLOCK_END),
    ...(removeState ? [statePlan(root)] : [])
  ];
}

function markerPlan(step, filePath, beginMarker, endMarker) {
  const build = () => removeMarkedBlock(readText(filePath, ''), beginMarker, endMarker);
  return {
    step,
    preview() {
      const result = build();
      return { step, filePath, affectedPaths: [filePath], ...result, dryRun: true };
    },
    apply() {
      const result = build();
      if (result.ok && result.changed) atomicWriteText(filePath, result.after);
      return { step, filePath, affectedPaths: [filePath], ...result, dryRun: false };
    }
  };
}

function hooksPlan(filePath) {
  const build = () => {
    const before = readText(filePath, '');
    if (!before.trim()) return { ok: true, action: 'unchanged', changed: false, after: before, removed: [] };
    let parsed;
    try { parsed = JSON.parse(before); } catch { return { ok: false, action: 'invalid-json', reason: 'hooks.json is malformed. Uninstall was not applied.' }; }
    try {
      const { doc, removed } = removeOtmHooksDocument(parsed);
      const after = `${JSON.stringify(doc, null, 2)}\n`;
      return { ok: true, action: removed.length ? 'removed' : 'unchanged', changed: after !== before, after, removed };
    } catch (error) { return { ok: false, action: 'invalid-json', reason: String(error.message || error) }; }
  };
  return { step: 'hooks', preview: () => ({ step: 'hooks', filePath, affectedPaths: [filePath], ...build(), dryRun: true }), apply: () => { const result = build(); if (result.ok && result.changed) atomicWriteText(filePath, result.after); return { step: 'hooks', filePath, affectedPaths: [filePath], ...result, dryRun: false }; } };
}

function skillPlan(root, packageRoot) {
  const sourceRoot = path.join(packageRoot, 'skills');
  const targetRoot = path.join(root, '.agents', 'skills');
  const preview = () => {
    const results = [];
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !fs.existsSync(path.join(sourceRoot, entry.name, 'SKILL.md'))) continue;
      const sourceDir = path.join(sourceRoot, entry.name);
      const targetDir = path.join(targetRoot, entry.name);
      if (!fs.existsSync(targetDir)) { results.push({ name: entry.name, path: targetDir, action: 'unchanged', removable: false }); continue; }
      if (matchesOwnedSkill(sourceDir, targetDir)) results.push({ name: entry.name, path: targetDir, action: 'removed', removable: true });
      else results.push({ name: entry.name, path: targetDir, action: 'skipped-ownership-mismatch', removable: false, warning: 'Skill contains changes or extra files and was preserved.' });
    }
    const removable = results.filter((item) => item.removable);
    return { ok: true, action: removable.length ? `${removable.length} removed` : 'unchanged', changed: removable.length > 0, installed: results, affectedPaths: removable.map((item) => item.path) };
  };
  return { step: 'skills', preview: () => ({ step: 'skills', ...preview(), dryRun: true }), apply: () => { const result = preview(); for (const skill of result.installed.filter((item) => item.removable)) fs.rmSync(skill.path, { recursive: true, force: false }); pruneEmptyParents(targetRoot, root); return { step: 'skills', ...result, dryRun: false }; } };
}

function statePlan(root) {
  const filePath = workspaceStateDir(root);
  const build = () => {
    if (!fs.existsSync(filePath)) return { ok: true, action: 'unchanged', changed: false };
    const inspection = inspectCurrentFiles(filePath);
    if (inspection.error) return { ok: false, action: 'corrupt-state', reason: inspection.error };
    if (inspection.activePaths.length) return { ok: false, action: 'active-state', reason: `Refusing to remove state while ${inspection.activePaths.length} active route snapshot(s) exist. Finalize and clear, or explicitly abandon the routes first.`, activePaths: inspection.activePaths };
    return { ok: true, action: 'removed', changed: true };
  };
  return { step: 'state', preview: () => ({ step: 'state', filePath, affectedPaths: [filePath], ...build(), dryRun: true }), apply: () => { const result = build(); if (result.ok && result.changed) fs.rmSync(filePath, { recursive: true, force: false }); return { step: 'state', filePath, affectedPaths: [filePath], ...result, dryRun: false }; } };
}

function inspectCurrentFiles(stateDir) {
  const currentFiles = [];
  const rootCurrent = path.join(stateDir, 'current.json');
  if (fs.existsSync(rootCurrent)) currentFiles.push(rootCurrent);
  const sessionsRoot = path.join(stateDir, 'sessions');
  if (fs.existsSync(sessionsRoot)) {
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      const current = path.join(sessionsRoot, entry.name, 'current.json');
      if (entry.isDirectory() && fs.existsSync(current)) currentFiles.push(current);
    }
  }
  const activePaths = [];
  for (const current of currentFiles) {
    let snapshot;
    try { snapshot = JSON.parse(fs.readFileSync(current, 'utf8')); } catch { return { activePaths, error: `Current state snapshot is malformed: ${current}. Preserve it and repair before removing state.` }; }
    if (['active', 'ready_to_finalize', 'blocked', 'paused'].includes(snapshot?.status)) activePaths.push(current);
  }
  return { activePaths, error: null };
}

function removeMarkedBlock(before, beginMarker, endMarker) {
  const beginCount = countMarker(before, beginMarker);
  const endCount = countMarker(before, endMarker);
  if (beginCount > 1 || endCount > 1 || beginCount !== endCount) return { ok: false, action: 'conflict', reason: 'Managed markers are duplicate or incomplete. Manual repair is required before uninstall.' };
  if (!beginCount) return { ok: true, action: 'unchanged', changed: false, after: before };
  const begin = before.indexOf(beginMarker);
  const end = before.indexOf(endMarker);
  if (end < begin) return { ok: false, action: 'conflict', reason: 'Managed markers are out of order. Manual repair is required before uninstall.' };
  const after = `${before.slice(0, begin).trimEnd()}\n${before.slice(end + endMarker.length).trimStart()}`.trimEnd() + (before.trim() ? '\n' : '');
  return { ok: true, action: 'removed', changed: after !== before, after };
}

function matchesOwnedSkill(sourceDir, targetDir) {
  const relativeFiles = listFiles(sourceDir);
  const targetFiles = listFiles(targetDir);
  if (relativeFiles.length !== targetFiles.length || relativeFiles.some((file, index) => file !== targetFiles[index])) return false;
  return relativeFiles.every((relative) => hashFile(path.join(sourceDir, relative)) === hashFile(path.join(targetDir, relative)));
}

function listFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full).map((child) => path.join(entry.name, child)));
    else if (entry.isFile()) files.push(entry.name);
    else return ['__unsupported_entry__'];
  }
  return files.sort();
}

function snapshotPaths(paths) {
  return [...new Set(paths)].map((filePath) => {
    const exists = fs.existsSync(filePath);
    const stat = exists ? fs.statSync(filePath) : null;
    return { filePath, exists, isFile: Boolean(stat?.isFile()), isDirectory: Boolean(stat?.isDirectory()), content: stat?.isFile() ? fs.readFileSync(filePath) : null, mode: stat?.isFile() ? stat.mode : null };
  });
}

function writeBackups(backupPath, root, originals) {
  const files = originals.map((item, index) => ({ filePath: item.filePath, existed: item.exists, isFile: item.isFile, isDirectory: item.isDirectory, beforeHash: item.isFile ? hashFile(item.filePath) : null, backupFile: item.isFile ? `${index}.bak` : item.isDirectory ? `${index}.dir` : null }));
  for (const [index, item] of originals.entries()) if (item.isFile) fs.writeFileSync(path.join(backupPath, `${index}.bak`), item.content, { mode: item.mode });
  for (const [index, item] of originals.entries()) if (item.isDirectory) {
    fs.cpSync(item.filePath, path.join(backupPath, `${index}.dir`), { recursive: true, force: true, errorOnExist: false });
    item.backupPath = backupPath;
  }
  fs.writeFileSync(path.join(backupPath, 'manifest.json'), `${JSON.stringify({ schemaVersion: 'otm.uninstall-backup.v1', workspaceRoot: root, files }, null, 2)}\n`, 'utf8');
}

function restorePaths(originals, root) {
  for (const item of originals) {
    if (item.isFile) { ensureDir(path.dirname(item.filePath)); fs.writeFileSync(item.filePath, item.content, { mode: item.mode }); }
    else if (item.isDirectory) {
      try { fs.rmSync(item.filePath, { recursive: true, force: true }); } catch {}
      const index = originals.indexOf(item);
      const backupRoot = item.backupPath;
      if (backupRoot) fs.cpSync(path.join(backupRoot, `${index}.dir`), item.filePath, { recursive: true, force: true });
    }
    else if (!item.exists) { try { fs.rmSync(item.filePath, { recursive: true, force: true }); } catch {} pruneEmptyParents(path.dirname(item.filePath), root); }
  }
}

function pruneEmptyParents(dir, root) {
  let current = dir;
  while (current.startsWith(root) && current !== root) { try { fs.rmdirSync(current); } catch { return; } current = path.dirname(current); }
}

function countMarker(text, marker) { return String(text).split(marker).length - 1; }

export function renderUninstallResult(result) {
  const lines = ['## Overtli Task Manager uninstall', '', `Workspace: \`${result.workspaceRoot}\``, `Mode: ${result.dryRun ? 'dry run' : 'applied'}`, '', '| Step | Result | Path |', '|---|---|---|'];
  for (const item of result.results) lines.push(`| ${item.step} | ${item.ok === false ? `warning: ${item.reason || item.action}` : item.action || 'unchanged'} | ${item.filePath || (item.installed ? `${item.installed.length} skill(s)` : '—')} |`);
  if (result.backupPath) lines.push('', `Backup: \`${result.backupPath}\``);
  lines.push('', 'Workspace state and summaries are retained unless --remove-state is explicitly confirmed.');
  return `${lines.join('\n')}\n`;
}
