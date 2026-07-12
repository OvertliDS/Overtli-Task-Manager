import fs from "node:fs";
import path from "node:path";
import {
  findWorkspaceRoot,
  readText,
  readJson,
  statSafe,
  hashFile,
  atomicWriteJson,
  atomicWriteText,
  cacheDir,
  ensureDir,
  relativeToWorkspace,
  workspaceTempDir,
} from "../core/fs-utils.mjs";
import { nowIso, shortHash } from "../core/ids.mjs";
import { clampText, compactOneLine } from "../core/text-utils.mjs";
import {
  canonicalizeWorkspaceRoot,
  resolveWithinRoot,
} from "../core/validation.mjs";

const ROOT_FILES = [
  "AGENTS.md",
  "AGENTS.override.md",
  "README.md",
  "readme.md",
  "ARCHITECTURE.md",
  "architecture.md",
  "PRODUCT.md",
  "PRD.md",
  "GDD.md",
  "GAME_DESIGN_DOCUMENT.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pnpm-workspace.yaml",
];
const DOC_DIRS = [
  "docs",
  "doc",
  "memory-bank",
  "memory_bank",
  ".ai",
  ".agents",
  "design",
  "product",
  "gdd",
];
const DOC_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
]);

export function reviewProjectContext({
  cwd = process.cwd(),
  workspaceRoot = null,
  maxFiles = 20,
  maxBytesPerFile = 12000,
} = {}) {
  const root = canonicalizeWorkspaceRoot(
    workspaceRoot || findWorkspaceRoot(cwd),
  ).displayPath;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100)
    throw new Error("maxFiles must be an integer between 1 and 100.");
  if (
    !Number.isInteger(maxBytesPerFile) ||
    maxBytesPerFile < 256 ||
    maxBytesPerFile > 256 * 1024
  )
    throw new Error(
      "maxBytesPerFile must be an integer between 256 and 262144.",
    );
  const candidateResult = collectCandidateFilesDetailed(root);
  const skipped = {
    ...candidateResult.skipped,
    limit: 0,
    oversized: 0,
    binary: 0,
    empty: 0,
  };
  // File eligibility is established before applying the caller's cap. A
  // binary/oversized candidate must never consume one of maxFiles slots.
  const eligible = [];
  for (const filePath of candidateResult.files) {
    const st = statSafe(filePath);
    if (!st || !st.isFile()) {
      skipped.notRegular = (skipped.notRegular || 0) + 1;
      continue;
    }
    if (st.size > maxBytesPerFile) {
      skipped.oversized += 1;
      continue;
    }
    if (isBinaryFile(filePath)) {
      skipped.binary += 1;
      continue;
    }
    eligible.push({ filePath, stat: st });
  }
  const candidates = eligible.slice(0, maxFiles);
  skipped.limit = Math.max(0, eligible.length - candidates.length);
  const sources = [];
  const sections = [];

  for (const { filePath, stat: st } of candidates) {
    const rel = relativeToWorkspace(root, filePath);
    const text = readText(filePath, "");
    if (!text.trim()) {
      skipped.empty += 1;
      continue;
    }
    const body = summarizeFile(rel, clampText(text, maxBytesPerFile));
    sources.push({
      path: rel,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      hash: hashFile(filePath),
    });
    sections.push(body);
  }

  const diagnostics = {
    algorithmVersion: "otm.project-review.v2",
    candidateCount: eligible.length,
    readCount: sources.length,
    skipped,
    limitsOmittedFiles: skipped.limit > 0,
  };
  const fingerprint = shortHash(
    JSON.stringify({
      sources: sources.map((src) => [src.path, src.hash]),
      maxFiles,
      maxBytesPerFile,
      algorithmVersion: diagnostics.algorithmVersion,
    }),
  );
  const reviewJsonPath = path.join(cacheDir(root), "project-review.json");
  const existing = readJson(reviewJsonPath, null);
  if (
    existing?.schemaVersion === "otm.project-review.v2" &&
    existing.fingerprint === fingerprint
  ) {
    return {
      ...existing,
      cacheStatus: "unchanged",
      unchanged: true,
    };
  }

  const summary = renderProjectSummary(root, sources, sections, diagnostics);
  const payload = {
    schemaVersion: "otm.project-review.v2",
    workspaceRoot: root,
    sourceCount: sources.length,
    sources,
    diagnostics,
    summary,
    createdAt: nowIso(),
    fingerprint,
    cacheStatus: "refreshed",
    unchanged: false,
  };
  ensureDir(cacheDir(root));
  const tempDir = workspaceTempDir(root);
  atomicWriteJson(reviewJsonPath, payload, { tempDir });
  atomicWriteText(path.join(cacheDir(root), "project-review.md"), summary, {
    tempDir,
  });
  return payload;
}

export function collectCandidateFiles(root, maxFiles) {
  return collectCandidateFilesDetailed(root).files.slice(0, maxFiles);
}

function collectCandidateFilesDetailed(root) {
  const canonicalRoot = canonicalizeWorkspaceRoot(root).displayPath;
  const seen = new Set();
  const out = [];
  const skipped = {
    outsideWorkspace: 0,
    notRegular: 0,
    unsupportedExtension: 0,
    duplicate: 0,
  };
  function add(filePath) {
    let resolved = path.resolve(filePath);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      skipped.notRegular += 1;
      return false;
    }
    try {
      resolveWithinRoot(canonicalRoot, resolved, {
        allowAbsolute: true,
        mustExist: true,
      });
    } catch {
      skipped.outsideWorkspace += 1;
      return false;
    }
    const stat = statSafe(resolved);
    if (!stat?.isFile()) {
      skipped.notRegular += 1;
      return false;
    }
    if (seen.has(resolved)) {
      skipped.duplicate += 1;
      return false;
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!DOC_EXTENSIONS.has(ext)) {
      skipped.unsupportedExtension += 1;
      return false;
    }
    const rel = relativeToWorkspace(canonicalRoot, resolved);
    if (
      rel.startsWith("..") ||
      rel.includes("node_modules/") ||
      rel.includes(".git/") ||
      rel.includes("dist/") ||
      rel.includes("build/")
    ) {
      skipped.outsideWorkspace += 1;
      return false;
    }
    seen.add(resolved);
    out.push(resolved);
    return true;
  }

  for (const name of ROOT_FILES) add(path.join(root, name));

  for (const dir of DOC_DIRS) {
    const dirPath = path.join(root, dir);
    if (!fs.existsSync(dirPath)) continue;
    walkDocs(dirPath, add, { depth: 3 });
  }

  return { files: out, skipped };
}

function walkDocs(dirPath, add, options, depth = 0) {
  if (depth > options.depth) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") && ![".ai", ".agents"].includes(entry.name))
      continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walkDocs(full, add, options, depth + 1);
    else {
      add(full);
    }
  }
}

function isBinaryFile(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const size = Math.min(4096, fs.fstatSync(handle).size);
    if (!size) return false;
    const buffer = Buffer.allocUnsafe(size);
    fs.readSync(handle, buffer, 0, size, 0);
    return buffer.includes(0);
  } finally {
    fs.closeSync(handle);
  }
}

function summarizeFile(rel, text) {
  const headings = Array.from(text.matchAll(/^#{1,3}\s+(.+)$/gm))
    .slice(0, 12)
    .map((m) => m[1].trim());
  const firstParagraph =
    text
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("#")) || "";
  const scripts = rel === "package.json" ? extractPackageScripts(text) : [];
  const lines = [];
  lines.push(`### ${rel}`);
  if (headings.length)
    lines.push(
      `Headings: ${headings.map((h) => `\`${compactOneLine(h, 80)}\``).join(", ")}`,
    );
  if (scripts.length)
    lines.push(`Scripts: ${scripts.map((s) => `\`${s}\``).join(", ")}`);
  if (firstParagraph)
    lines.push(compactOneLine(firstParagraph.replace(/\n+/g, " "), 500));
  return lines.join("\n");
}

function extractPackageScripts(text) {
  try {
    const pkg = JSON.parse(text);
    return Object.keys(pkg.scripts || {}).slice(0, 16);
  } catch {
    return [];
  }
}

function renderProjectSummary(root, sources, sections, diagnostics) {
  const lines = [];
  lines.push("# Overtli Task Manager project review");
  lines.push("");
  lines.push(`Workspace: \`${root}\``);
  lines.push(`Eligible candidates: ${diagnostics.candidateCount}`);
  lines.push(`Sources checked: ${sources.length}`);
  lines.push(
    `Skipped: ${Object.values(diagnostics.skipped).reduce((total, value) => total + Number(value || 0), 0)}${diagnostics.limitsOmittedFiles ? " (file limit omitted eligible files)" : ""}`,
  );
  lines.push("");
  lines.push(
    "This is a lightweight project-awareness cache. It intentionally prefers existing overview files, agent guidance, docs, memory banks, manifests, PRDs, GDDs, and architecture files instead of scanning every source file.",
  );
  lines.push("");
  lines.push("## Signals");
  lines.push("");
  for (const section of sections) {
    lines.push(section);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
