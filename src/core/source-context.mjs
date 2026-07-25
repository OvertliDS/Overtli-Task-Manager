import { sha256, shortHash } from "./ids.mjs";
import { OtmError } from "./errors.mjs";
import {
  LIMITS,
  assertAcyclicContext,
  redactSensitiveText,
} from "./validation.mjs";

const SOURCE_CONTEXT_SCHEMA = "otm.source-context.v1";
const ENTRY_CHUNK_BYTES = 64 * 1024;
const MAX_ENTRIES = 128;

const SOURCE_FIELDS = Object.freeze([
  ["prompt", "inline_prompt", "Inline prompt"],
  ["context", "supplemental_context", "Supplemental context"],
  ["promptContext", "prompt_context", "Prompt context"],
  ["attachments", "attachment", "Attachments"],
  ["screenshots", "visual_context", "Screenshot guidance"],
  ["images", "visual_context", "Image guidance"],
]);

const CONTENT_KEYS = new Set([
  "text",
  "content",
  "body",
  "description",
  "caption",
  "ocr",
  "transcript",
  "prompt",
]);

const LABEL_KEYS = ["title", "name", "filename", "fileName", "path", "type"];

export function normalizeSourceContext(input = {}, options = {}) {
  assertAcyclicContext(input);
  const at = options.at || new Date().toISOString();
  const revision = Number(options.revision || 1);
  const entries = [];
  const seen = new Set();
  let totalBytes = 0;

  for (const [field, kind, label] of SOURCE_FIELDS) {
    collectValue(input[field], {
      kind,
      label,
      path: field,
      entries,
      seen,
      addEntry,
    });
  }

  function addEntry({ kind, label, path, text, sourceRef }) {
    const clean = redactSensitiveText(normalizeText(text));
    if (!clean) return;
    for (const [chunkIndex, chunk] of splitUtf8(
      clean,
      ENTRY_CHUNK_BYTES,
    ).entries()) {
      const chunkBytes = Buffer.byteLength(chunk);
      if (
        entries.length >= MAX_ENTRIES ||
        totalBytes + chunkBytes > LIMITS.contextBytes
      )
        throw sourceContextTooLarge();
      const identity = sha256(`${kind}\0${path}\0${chunk}`);
      if (seen.has(identity)) continue;
      seen.add(identity);
      totalBytes += chunkBytes;
      entries.push({
        id: `source_${shortHash(identity, 24)}`,
        kind,
        label: chunkIndex ? `${label} (part ${chunkIndex + 1})` : label,
        path,
        text: chunk,
        bytes: chunkBytes,
        revision,
        addedAt: at,
        ...(sourceRef ? { sourceRef: redactSensitiveText(sourceRef) } : {}),
      });
    }
  }

  return buildSourceContext(entries, [
    {
      revision,
      sourceIds: entries.map((entry) => entry.id),
      digest: digestEntries(entries),
      addedAt: at,
    },
  ]);
}

export function mergeSourceContexts(existing, incoming, options = {}) {
  const left = normalizeExistingSourceContext(existing);
  const right = normalizeExistingSourceContext(incoming);
  if (!right.entries.length) return left;
  const entries = [...left.entries];
  const seen = new Set(entries.map(entryIdentity));
  let totalBytes = entries.reduce(
    (sum, entry) => sum + Buffer.byteLength(entry.text),
    0,
  );
  const addedIds = [];
  for (const entry of right.entries) {
    const identity = entryIdentity(entry);
    if (seen.has(identity)) continue;
    const bytes = Buffer.byteLength(entry.text);
    if (
      entries.length >= MAX_ENTRIES ||
      totalBytes + bytes > LIMITS.contextBytes
    )
      throw sourceContextTooLarge();
    seen.add(identity);
    totalBytes += bytes;
    entries.push(entry);
    addedIds.push(entry.id);
  }
  if (!addedIds.length) return left;
  const revision = Number(options.revision || latestRevision(left) + 1);
  const at = options.at || new Date().toISOString();
  const revisions = [
    ...(left.revisions || []),
    {
      revision,
      sourceIds: addedIds,
      digest: digestEntries(entries),
      addedAt: at,
    },
  ];
  return buildSourceContext(entries, revisions);
}

export function sourceContextText(sourceContext) {
  const normalized = normalizeExistingSourceContext(sourceContext);
  return normalized.entries
    .map((entry) => `${entry.label} [${entry.path}]:\n${entry.text}`)
    .join("\n\n");
}

export function sourceContextSummary(sourceContext) {
  const normalized = normalizeExistingSourceContext(sourceContext);
  const kinds = Object.fromEntries(
    [...new Set(normalized.entries.map((entry) => entry.kind))].map((kind) => [
      kind,
      normalized.entries.filter((entry) => entry.kind === kind).length,
    ]),
  );
  return {
    schemaVersion: normalized.schemaVersion,
    digest: normalized.digest,
    entryCount: normalized.entryCount,
    totalBytes: normalized.totalBytes,
    revisionCount: normalized.revisions.length,
    kinds,
  };
}

export function normalizePersistedSourceContext(sourceContext) {
  return normalizeExistingSourceContext(sourceContext);
}

export function hasSourceContextInput(input = {}) {
  return SOURCE_FIELDS.some(
    ([field]) =>
      input[field] !== undefined &&
      input[field] !== null &&
      !(typeof input[field] === "string" && !input[field].trim()) &&
      !(Array.isArray(input[field]) && input[field].length === 0),
  );
}

function collectValue(value, context) {
  if (value === undefined || value === null) return;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    context.addEntry({
      kind: context.kind,
      label: context.label,
      path: context.path,
      text: String(value),
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectValue(item, {
        ...context,
        label: `${context.label} ${index + 1}`,
        path: `${context.path}[${index}]`,
      }),
    );
    return;
  }
  if (typeof value !== "object") return;

  const objectLabel = LABEL_KEYS.map((key) => value[key]).find(
    (item) => typeof item === "string" && item.trim(),
  );
  const sourceRef = ["path", "filename", "fileName"]
    .map((key) => value[key])
    .find((item) => typeof item === "string" && item.trim());
  const contentEntries = Object.entries(value).filter(
    ([key, item]) => CONTENT_KEYS.has(key) && isScalar(item),
  );
  if (contentEntries.length) {
    for (const [key, item] of contentEntries)
      context.addEntry({
        kind: context.kind,
        label: objectLabel ? `${context.label}: ${objectLabel}` : context.label,
        path: `${context.path}.${key}`,
        text: String(item),
        sourceRef: sourceRef ? String(sourceRef) : undefined,
      });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (LABEL_KEYS.includes(key)) continue;
    collectValue(item, {
      ...context,
      label: objectLabel
        ? `${context.label}: ${objectLabel}`
        : `${context.label}: ${key}`,
      path: `${context.path}.${key}`,
    });
  }
}

function normalizeExistingSourceContext(value) {
  if (!value || !Array.isArray(value.entries))
    return buildSourceContext([], []);
  const entries = value.entries
    .filter((entry) => entry && typeof entry === "object" && entry.text)
    .map((entry, index) => {
      const text = redactSensitiveText(normalizeText(entry.text));
      return {
        id:
          String(entry.id || "").trim() ||
          `source_${shortHash(`${entry.kind || "context"}:${text}:${index}`, 24)}`,
        kind: String(entry.kind || "context"),
        label: String(entry.label || "Context"),
        path: String(entry.path || `context[${index}]`),
        text,
        bytes: Buffer.byteLength(text),
        revision: Number(entry.revision || 1),
        addedAt: String(entry.addedAt || new Date(0).toISOString()),
        ...(entry.sourceRef
          ? { sourceRef: redactSensitiveText(String(entry.sourceRef)) }
          : {}),
      };
    });
  if (
    entries.length > MAX_ENTRIES ||
    entries.reduce((sum, entry) => sum + entry.bytes, 0) > LIMITS.contextBytes
  )
    throw sourceContextTooLarge();
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id))
      throw new OtmError("Source context contains duplicate entry ids.", {
        code: "DUPLICATE_ID",
        details: { id: entry.id, collection: "source context" },
      });
    ids.add(entry.id);
  }
  if (Array.isArray(value.revisions) && value.revisions.length > 256)
    throw new OtmError("Source context contains too many revisions.", {
      code: "INPUT_TOO_LARGE",
      details: { maxRevisions: 256 },
    });
  return buildSourceContext(
    entries,
    Array.isArray(value.revisions) ? value.revisions : [],
  );
}

function buildSourceContext(entries, revisions) {
  const totalBytes = entries.reduce(
    (sum, entry) => sum + Buffer.byteLength(entry.text),
    0,
  );
  return {
    schemaVersion: SOURCE_CONTEXT_SCHEMA,
    digest: digestEntries(entries),
    entryCount: entries.length,
    totalBytes,
    entries,
    revisions,
  };
}

function entryIdentity(entry) {
  return sha256(`${entry.kind}\0${entry.path}\0${entry.text}`);
}

function digestEntries(entries) {
  return sha256(
    entries
      .map((entry) => `${entry.kind}\0${entry.path}\0${entry.text}`)
      .join("\n\u001e\n"),
  );
}

function latestRevision(sourceContext) {
  return Math.max(
    0,
    ...(sourceContext.revisions || []).map((item) =>
      Number(item.revision || 0),
    ),
  );
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function splitUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return [value];
  const chunks = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes && current) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

function isScalar(value) {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function sourceContextTooLarge() {
  return new OtmError(
    `Accumulated source context exceeds the bounded ${LIMITS.contextBytes}-byte or ${MAX_ENTRIES}-entry limit.`,
    { code: "INPUT_TOO_LARGE" },
  );
}
