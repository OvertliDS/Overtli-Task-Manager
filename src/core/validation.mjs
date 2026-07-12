import fs from "node:fs";
import path from "node:path";
import { OtmError } from "./errors.mjs";
import { shortHash } from "./ids.mjs";

export const LIMITS = Object.freeze({
  id: 128,
  title: 500,
  text: 16_000,
  evidence: 32,
  tasks: 256,
  internalSteps: 128,
  contextBytes: 256 * 1024,
});

/**
 * Provides a stable persisted workspace identity while retaining a display path.
 * Windows identity comparison is case insensitive even when tests run elsewhere.
 */
export function canonicalizeWorkspaceRoot(value) {
  assertNonEmptyString(value, "workspaceRoot", LIMITS.text);
  const displayPath = path.resolve(value.trim());
  let resolvedPath = displayPath;
  try {
    resolvedPath = fs.realpathSync.native(displayPath);
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw new OtmError("Unable to resolve workspace root.", {
        code: "INVALID_WORKSPACE_ROOT",
        details: { path: displayPath },
      });
  }
  const normalizedPath =
    path.normalize(resolvedPath).replace(/[\\/]+$/, "") ||
    path.parse(resolvedPath).root;
  return Object.freeze({
    displayPath: normalizedPath,
    persistedId: workspaceIdentity(normalizedPath),
  });
}

export function workspaceIdentity(value) {
  const normalized =
    path.normalize(path.resolve(value)).replace(/[\\/]+$/, "") ||
    path.parse(path.resolve(value)).root;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Resolve a user supplied path only if its final real path remains inside root. */
export function resolveWithinRoot(root, candidate, options = {}) {
  const { allowAbsolute = false, mustExist = false } = options;
  const canonicalRoot = canonicalizeWorkspaceRoot(root).displayPath;
  assertNonEmptyString(candidate, "path", LIMITS.text);
  if (path.isAbsolute(candidate) && !allowAbsolute) {
    throw new OtmError("Absolute paths are not allowed for this operation.", {
      code: "PATH_ABSOLUTE_NOT_ALLOWED",
    });
  }
  const segments = String(candidate).replace(/\\/g, "/").split("/");
  if (segments.includes(".."))
    throw new OtmError("Path traversal is not allowed.", {
      code: "PATH_TRAVERSAL",
    });
  const target = path.resolve(canonicalRoot, candidate);
  assertWithin(canonicalRoot, target);
  let finalPath = target;
  try {
    finalPath = fs.realpathSync.native(target);
  } catch (error) {
    if (mustExist || error?.code !== "ENOENT")
      throw new OtmError(
        "Requested path does not exist or cannot be resolved.",
        { code: "PATH_UNRESOLVABLE", details: { path: target } },
      );
    // Existing parent symlinks must still be contained for a safe future write.
    let parent = path.dirname(target);
    while (parent !== canonicalRoot && !fs.existsSync(parent))
      parent = path.dirname(parent);
    try {
      assertWithin(canonicalRoot, fs.realpathSync.native(parent));
    } catch (cause) {
      throw cause;
    }
  }
  assertWithin(canonicalRoot, finalPath);
  return finalPath;
}

export function safeGeneratedFileId(namespace, externalId) {
  assertNonEmptyString(namespace, "namespace", 64);
  return `${namespace}-${shortHash(String(externalId), 24)}`;
}

export function assertKnownEnum(value, allowed, name) {
  if (!allowed.has(value))
    throw new OtmError(`Invalid ${name}.`, {
      code: "INVALID_ENUM",
      details: { field: name, value },
    });
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} [maxLength]
 */
export function assertNonEmptyString(value, name, maxLength = LIMITS.text) {
  if (typeof value !== "string" || !value.trim())
    throw new OtmError(`${name} is required.`, {
      code: "INVALID_INPUT",
      details: { field: name },
    });
  if (value.length > maxLength)
    throw new OtmError(`${name} exceeds the maximum length.`, {
      code: "INPUT_TOO_LARGE",
      details: { field: name, maxLength },
    });
  return value.trim();
}

export function assertUniqueIds(items, name) {
  const ids = new Set();
  for (const item of items || []) {
    const id = assertNonEmptyString(item?.id, `${name} id`, LIMITS.id);
    if (ids.has(id))
      throw new OtmError(`Duplicate ${name} id.`, {
        code: "DUPLICATE_ID",
        details: { id, collection: name },
      });
    ids.add(id);
  }
}

export function assertAcyclicContext(value, maxBytes = LIMITS.contextBytes) {
  const seen = new WeakSet();
  let bytes = 0;
  const visit = (current) => {
    if (typeof current === "string") {
      bytes += Buffer.byteLength(current);
      return;
    }
    if (!current || typeof current !== "object") {
      bytes += Buffer.byteLength(String(current ?? ""));
      return;
    }
    if (seen.has(current))
      throw new OtmError("Structured prompt context contains a cycle.", {
        code: "CYCLIC_CONTEXT",
      });
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      bytes += Buffer.byteLength(key);
      visit(child);
    }
    seen.delete(current);
  };
  visit(value);
  if (bytes > maxBytes)
    throw new OtmError(
      "Structured prompt context exceeds the total size budget.",
      { code: "CONTEXT_TOO_LARGE", details: { maxBytes } },
    );
  return bytes;
}

/** Remove common credential forms before evidence reaches durable stores/files. */
export function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/(authorization\s*[:=]\s*bearer\s+)([^\s,;"']+)/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,}|(?:xox[baprs]-)[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gi,
      "[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED JWT]",
    )
    .replace(
      /(\b(?:[A-Za-z][A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|private[_-]?key|authorization|credential(?:s)?|database[_-]?url)[A-Za-z0-9_]*|api[_-]?key|token|secret|password|private[_-]?key|authorization|credential(?:s)?|database[_-]?url)\s*[:=]\s*["']?)([^\s"']+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
}

function assertWithin(root, target) {
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    return;
  throw new OtmError("Path escapes the permitted root.", {
    code: "PATH_OUTSIDE_ROOT",
    details: { root },
  });
}
