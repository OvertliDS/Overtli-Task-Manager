import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewProjectContext } from "../src/context/project-review.mjs";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otm-review-test-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Readme\n\nEligible root overview.\n",
    "utf8",
  );
  return root;
}

test("project review filters binary and oversized candidates before maxFiles", () => {
  const workspaceRoot = workspace();
  const docs = path.join(workspaceRoot, "docs");
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, "00-binary.txt"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(
    path.join(docs, "01-large.md"),
    `# Large\n\n${"x".repeat(400)}`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(docs, "02-eligible.md"),
    "# Eligible\n\nThis must still be selected.\n",
    "utf8",
  );
  const review = reviewProjectContext({
    workspaceRoot,
    maxFiles: 2,
    maxBytesPerFile: 256,
  });
  assert.equal(review.sourceCount, 2);
  assert.ok(
    review.sources.some(
      (source) => source.path.replace(/\\/g, "/") === "docs/02-eligible.md",
    ),
  );
  assert.equal(review.diagnostics.skipped.binary, 1);
  assert.equal(review.diagnostics.skipped.oversized, 1);
  assert.equal(review.diagnostics.candidateCount, 2);
});

test("project review enforces containment and reports limit omission deterministically", () => {
  const workspaceRoot = workspace();
  const docs = path.join(workspaceRoot, "docs");
  fs.mkdirSync(docs);
  for (let index = 0; index < 4; index += 1)
    fs.writeFileSync(
      path.join(docs, `guide-${index}.md`),
      `# Guide ${index}\n\nBody ${index}.\n`,
      "utf8",
    );
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "otm-review-outside-"));
  fs.writeFileSync(
    path.join(outside, "secret.md"),
    "# Secret\n\nMUST_NOT_APPEAR\n",
    "utf8",
  );
  fs.symlinkSync(
    outside,
    path.join(docs, "outside"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const review = reviewProjectContext({ workspaceRoot, maxFiles: 2 });
  assert.equal(review.diagnostics.candidateCount, 5);
  assert.equal(review.diagnostics.limitsOmittedFiles, true);
  assert.equal(review.diagnostics.skipped.limit, 3);
  assert.doesNotMatch(review.summary, /MUST_NOT_APPEAR/);
  assert.ok(review.diagnostics.skipped.outsideWorkspace >= 1);
});
