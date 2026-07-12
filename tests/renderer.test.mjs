import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSnapshot,
  renderSnapshotMarkdown,
  renderDeltaMarkdown,
  renderSummaryMarkdown,
  writeCurrentFiles,
} from "../src/core/renderer.mjs";

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otm-renderer-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function sampleSnapshot(
  workspaceRoot,
  update = {
    kind: "task_completed",
    taskId: "one",
    message: "Completed *one* safely",
  },
) {
  const run = {
    id: "run-render",
    workspaceRoot,
    sessionId: null,
    goal: "# Goal [unsafe](url)",
    status: "active",
    routeRevision: 2,
    currentTaskId: "two",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
  const tasks = [
    {
      id: "one",
      title: "*First* | done",
      status: "done",
      required: true,
      priority: 50,
      sortOrder: 1,
      evidence: [{ summary: "[passing](unsafe)" }],
      metadata: {},
    },
    {
      id: "two",
      title: "Second _active_",
      status: "active",
      required: true,
      priority: 50,
      sortOrder: 2,
      evidence: [],
      metadata: {
        internalSteps: [
          { id: "step", title: "Use `safe` output", status: "active" },
        ],
      },
    },
  ];
  return buildSnapshot({
    run,
    tasks,
    workspaceRoot,
    storageKind: "json",
    lastUpdate: update,
  });
}

test("renderer preserves planned order and escapes all untrusted Markdown surfaces", () => {
  const snapshot = sampleSnapshot(tempWorkspace());
  assert.deepEqual(
    snapshot.tasks.map((task) => task.id),
    ["one", "two"],
  );
  assert.equal(snapshot.tasks[1].metadata.internalSteps, undefined);
  assert.deepEqual(
    snapshot.tasks[1].internalSteps.map((step) => step.title),
    ["Use `safe` output"],
  );
  const full = renderSnapshotMarkdown(snapshot);
  const delta = renderDeltaMarkdown(snapshot);
  const summary = renderSummaryMarkdown({
    goal: "# Goal",
    outcome: "[done](unsafe)",
    completed: ["*First*"],
    blocked: ["`blocked`"],
    dropped: ["_drop_"],
    evidence: ["[proof](unsafe)"],
    nextSteps: ["# next"],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(full.includes("\\# Goal \\[unsafe\\]\\(url\\)"));
  assert.ok(full.includes("\\*First\\* \\| done"));
  assert.ok(full.includes("Second \\_active\\_"));
  assert.ok(full.includes("Use \\`safe\\` output"));
  assert.ok(delta.includes("Completed \\*one\\* safely"));
  assert.ok(delta.includes("Completed: \\*First\\*"));
  assert.ok(summary.includes("\\# Goal"));
  assert.ok(summary.includes("\\[done\\]\\(unsafe\\)"));
  assert.ok(summary.includes("\\*First\\*"));
});

test("renderer suppresses unchanged current-file writes", () => {
  const workspaceRoot = tempWorkspace();
  const snapshot = sampleSnapshot(workspaceRoot, {
    kind: "run_started",
    message: "Start",
  });
  const first = writeCurrentFiles(workspaceRoot, snapshot);
  const second = writeCurrentFiles(workspaceRoot, snapshot);
  assert.equal(first.jsonChanged, true);
  assert.equal(first.markdownChanged, true);
  assert.equal(second.jsonChanged, false);
  assert.equal(second.markdownChanged, false);
});

test("renderer preserves malformed OTM snapshots instead of overwriting them", () => {
  const workspaceRoot = tempWorkspace();
  const snapshot = sampleSnapshot(workspaceRoot, {
    kind: "run_started",
    message: "Start",
  });
  const currentPath = path.join(
    workspaceRoot,
    ".codex",
    "overtli-task-manager",
    "current.json",
  );
  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  fs.writeFileSync(currentPath, "{not valid json", "utf8");

  assert.throws(() => writeCurrentFiles(workspaceRoot, snapshot), {
    code: "SNAPSHOT_CORRUPTION",
  });
  assert.equal(fs.readFileSync(currentPath, "utf8"), "{not valid json");

  const scoped = sampleSnapshot(workspaceRoot, {
    kind: "run_started",
    message: "Scoped start",
  });
  scoped.sessionId = "session-one";
  fs.writeFileSync(currentPath, "{still malformed", "utf8");
  assert.throws(() => writeCurrentFiles(workspaceRoot, scoped), {
    code: "SNAPSHOT_CORRUPTION",
  });
  assert.equal(fs.readFileSync(currentPath, "utf8"), "{still malformed");
});
