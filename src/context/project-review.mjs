import fs from 'node:fs';
import path from 'node:path';
import { findWorkspaceRoot, readText, statSafe, hashFile, atomicWriteJson, atomicWriteText, cacheDir, ensureDir, relativeToWorkspace } from '../core/fs-utils.mjs';
import { nowIso, shortHash } from '../core/ids.mjs';
import { clampText, compactOneLine } from '../core/text-utils.mjs';

const ROOT_FILES = [
  'README.md', 'readme.md', 'AGENTS.md', 'AGENTS.override.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pnpm-workspace.yaml',
  'ARCHITECTURE.md', 'architecture.md', 'PRODUCT.md', 'PRD.md', 'GDD.md', 'GAME_DESIGN_DOCUMENT.md'
];
const DOC_DIRS = ['docs', 'doc', 'memory-bank', 'memory_bank', '.ai', '.agents', 'design', 'product', 'gdd'];
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.json', '.toml', '.yaml', '.yml']);

export function reviewProjectContext({ cwd = process.cwd(), workspaceRoot = null, maxFiles = 30, maxBytesPerFile = 12000 } = {}) {
  const root = path.resolve(workspaceRoot || findWorkspaceRoot(cwd));
  const candidates = collectCandidateFiles(root, maxFiles);
  const sources = [];
  const sections = [];

  for (const filePath of candidates) {
    const st = statSafe(filePath);
    if (!st || !st.isFile()) continue;
    const rel = relativeToWorkspace(root, filePath);
    const text = readText(filePath, '');
    if (!text.trim()) continue;
    const body = summarizeFile(rel, clampText(text, maxBytesPerFile));
    sources.push({ path: rel, bytes: st.size, mtimeMs: st.mtimeMs, hash: hashFile(filePath) });
    sections.push(body);
  }

  const summary = renderProjectSummary(root, sources, sections);
  const payload = {
    schemaVersion: 'otm.project-review.v1',
    workspaceRoot: root,
    sourceCount: sources.length,
    sources,
    summary,
    createdAt: nowIso(),
    fingerprint: shortHash(JSON.stringify(sources.map((src) => [src.path, src.hash, src.mtimeMs])))
  };
  ensureDir(cacheDir(root));
  atomicWriteJson(path.join(cacheDir(root), 'project-review.json'), payload);
  atomicWriteText(path.join(cacheDir(root), 'project-review.md'), summary);
  return payload;
}

export function collectCandidateFiles(root, maxFiles) {
  const seen = new Set();
  const out = [];
  function add(filePath) {
    let resolved = path.resolve(filePath);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {}
    if (seen.has(resolved)) return;
    const ext = path.extname(resolved).toLowerCase();
    if (!DOC_EXTENSIONS.has(ext)) return;
    const rel = relativeToWorkspace(root, resolved);
    if (rel.includes('node_modules/') || rel.includes('.git/') || rel.includes('dist/') || rel.includes('build/')) return;
    seen.add(resolved);
    out.push(resolved);
  }

  for (const name of ROOT_FILES) add(path.join(root, name));

  for (const dir of DOC_DIRS) {
    const dirPath = path.join(root, dir);
    if (!fs.existsSync(dirPath)) continue;
    walkDocs(dirPath, add, { limit: Math.max(5, maxFiles - out.length), depth: 3 });
    if (out.length >= maxFiles) break;
  }

  return out.slice(0, maxFiles);
}

function walkDocs(dirPath, add, options, depth = 0) {
  if (depth > options.depth || options.limit <= 0) return;
  let entries = [];
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.') && !['.ai', '.agents'].includes(entry.name)) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walkDocs(full, add, options, depth + 1);
    else {
      add(full);
      options.limit -= 1;
      if (options.limit <= 0) return;
    }
  }
}

function summarizeFile(rel, text) {
  const headings = Array.from(text.matchAll(/^#{1,3}\s+(.+)$/gm)).slice(0, 12).map((m) => m[1].trim());
  const firstParagraph = text.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part && !part.startsWith('#')) || '';
  const scripts = rel === 'package.json' ? extractPackageScripts(text) : [];
  const lines = [];
  lines.push(`### ${rel}`);
  if (headings.length) lines.push(`Headings: ${headings.map((h) => `\`${compactOneLine(h, 80)}\``).join(', ')}`);
  if (scripts.length) lines.push(`Scripts: ${scripts.map((s) => `\`${s}\``).join(', ')}`);
  if (firstParagraph) lines.push(compactOneLine(firstParagraph.replace(/\n+/g, ' '), 500));
  return lines.join('\n');
}

function extractPackageScripts(text) {
  try {
    const pkg = JSON.parse(text);
    return Object.keys(pkg.scripts || {}).slice(0, 16);
  } catch {
    return [];
  }
}

function renderProjectSummary(root, sources, sections) {
  const lines = [];
  lines.push('# Overtli Task Manager project review');
  lines.push('');
  lines.push(`Workspace: \`${root}\``);
  lines.push(`Sources checked: ${sources.length}`);
  lines.push('');
  lines.push('This is a lightweight project-awareness cache. It intentionally prefers existing overview files, agent guidance, docs, memory banks, manifests, PRDs, GDDs, and architecture files instead of scanning every source file.');
  lines.push('');
  lines.push('## Signals');
  lines.push('');
  for (const section of sections) {
    lines.push(section);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
