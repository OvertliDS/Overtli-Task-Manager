export function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function clampText(value, max = 4000) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n…[truncated]`;
}

export function tokenize(value) {
  return Array.from(
    new Set(
      String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9_\-\s]/g, " ")
        .split(/\s+/)
        .filter((part) => part.length >= 3 && !STOP_WORDS.has(part)),
    ),
  );
}

export function similarityScore(a, b) {
  const aa = tokenize(a);
  const bb = new Set(tokenize(b));
  if (!aa.length || !bb.size) return 0;
  let hits = 0;
  for (const token of aa) if (bb.has(token)) hits += 1;
  return hits / Math.sqrt(aa.length * bb.size);
}

export function markdownEscapeCell(value) {
  return markdownEscapeText(value).replace(/\|/g, "\\|");
}

/** Escape untrusted inline text in Markdown renderers without making it opaque. */
export function markdownEscapeText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/[\`*_{}\[\]<>#+\-!()]/g, "\\$&")
    .replace(/\r?\n+/g, " ");
}

export function compactOneLine(value, max = 140) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "you",
  "your",
  "are",
  "was",
  "were",
  "will",
  "shall",
  "can",
  "could",
  "would",
  "should",
  "into",
  "onto",
  "than",
  "then",
  "them",
  "they",
  "have",
  "has",
  "had",
  "not",
  "but",
  "about",
  "over",
  "under",
  "again",
  "also",
  "only",
  "just",
  "like",
  "what",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "each",
  "more",
  "most",
  "some",
  "such",
  "make",
  "made",
  "use",
  "using",
  "used",
]);
