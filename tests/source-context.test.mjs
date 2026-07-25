import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeSourceContexts,
  normalizeSourceContext,
  sourceContextSummary,
  sourceContextText,
} from "../src/core/source-context.mjs";
import { LIMITS } from "../src/core/validation.mjs";

test("source context normalizes typed, pasted, attachment, OCR, and visual descriptions", () => {
  const context = normalizeSourceContext(
    {
      prompt: "Phase 2 repairs startup.",
      promptContext: { text: "Phase 2.1 preserves pasted requirements." },
      attachments: [
        {
          filename: "plan.txt",
          content: "Phase 2.2 reads attachment text.",
        },
        {
          filename: "scan.png",
          ocr: "Phase 2.3 retains OCR text.",
        },
      ],
      screenshots: [{ caption: "Phase 2.4 is visibly blocked." }],
      images: [{ description: "Phase 2.5 shows the recovery state." }],
    },
    { at: "2026-01-01T00:00:00.000Z", revision: 1 },
  );

  assert.deepEqual(
    new Set(context.entries.map((entry) => entry.kind)),
    new Set([
      "inline_prompt",
      "prompt_context",
      "attachment",
      "visual_context",
    ]),
  );
  const rendered = sourceContextText(context);
  for (const outline of ["2.1", "2.2", "2.3", "2.4", "2.5"])
    assert.match(rendered, new RegExp(`Phase ${outline.replace(".", "\\.")}`));
  assert.equal(context.revisions.length, 1);
  assert.equal(sourceContextSummary(context).entryCount, 6);
});

test("source-context merge is append-only, deduplicated, redacted, and revisioned", () => {
  const first = normalizeSourceContext(
    {
      prompt: "Preserve original requirement.",
      context: "Authorization: Bearer secret-value",
    },
    { at: "2026-01-01T00:00:00.000Z", revision: 1 },
  );
  const second = normalizeSourceContext(
    {
      prompt: "Preserve original requirement.",
      attachments: [{ text: "Add steering requirement." }],
    },
    { at: "2026-01-02T00:00:00.000Z", revision: 2 },
  );
  const merged = mergeSourceContexts(first, second, {
    at: "2026-01-02T00:00:00.000Z",
    revision: 2,
  });

  assert.equal(
    merged.entries.filter(
      (entry) => entry.text === "Preserve original requirement.",
    ).length,
    1,
  );
  assert.match(sourceContextText(merged), /Add steering requirement/);
  assert.doesNotMatch(sourceContextText(merged), /secret-value/);
  assert.match(sourceContextText(merged), /\[REDACTED\]/);
  assert.equal(merged.revisions.length, 2);
  assert.notEqual(merged.digest, first.digest);
});

test("source context rejects cycles and accumulated input beyond the bounded limit", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => normalizeSourceContext({ context: cyclic }),
    (error) => error.code === "CYCLIC_CONTEXT",
  );
  assert.throws(
    () =>
      normalizeSourceContext({
        prompt: "x".repeat(LIMITS.contextBytes + 1),
      }),
    (error) => error.code === "CONTEXT_TOO_LARGE",
  );
});
