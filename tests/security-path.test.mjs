import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskManager } from "../src/core/manager.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";
import {
  canonicalizeWorkspaceRoot,
  redactSensitiveText,
  resolveWithinRoot,
} from "../src/core/validation.mjs";
import { installWorkspace } from "../src/install/install-workspace.mjs";

function tempWorkspace(prefix = "otm-security-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function jsonEnv(name) {
  return {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), `${name}-state-`)),
  };
}

test("safe path utilities reject traversal, external targets, and symlink escapes", () => {
  const workspaceRoot = tempWorkspace();
  const external = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-security-external-"),
  );
  fs.mkdirSync(path.join(workspaceRoot, "safe"));
  fs.symlinkSync(
    external,
    path.join(workspaceRoot, "safe", "outside"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    canonicalizeWorkspaceRoot(workspaceRoot).displayPath,
    fs.realpathSync.native(workspaceRoot),
  );
  assert.throws(() => resolveWithinRoot(workspaceRoot, "../escape"), {
    code: "PATH_TRAVERSAL",
  });
  assert.throws(() => resolveWithinRoot(workspaceRoot, external), {
    code: "PATH_ABSOLUTE_NOT_ALLOWED",
  });
  assert.throws(
    () => resolveWithinRoot(workspaceRoot, "safe/outside/file.txt"),
    { code: "PATH_OUTSIDE_ROOT" },
  );
  assert.equal(
    resolveWithinRoot(workspaceRoot, "nested/output.json"),
    path.join(workspaceRoot, "nested", "output.json"),
  );
});

test("route creation rejects cyclic structured prompt context before planning", () => {
  const workspaceRoot = tempWorkspace();
  const manager = createTaskManager({
    cwd: workspaceRoot,
    env: jsonEnv("otm-cyclic-context"),
  });
  const context = {};
  context.self = context;
  assert.throws(
    () => manager.start({ workspaceRoot, goal: "Cycle", context }),
    { code: "CYCLIC_CONTEXT" },
  );
});

test("summary and turn identifiers remain metadata and cannot escape the summaries directory", () => {
  const workspaceRoot = tempWorkspace("otm-summary-safe-name-");
  const manager = createTaskManager({
    cwd: workspaceRoot,
    env: jsonEnv("otm-summary-safe-name"),
  });
  const started = manager.start({
    workspaceRoot,
    goal: "Publish safely",
    tasks: [{ title: "Complete route" }],
  });
  const taskId = started.snapshot.tasks[0].id;
  for (const step of manager.store.getTask(taskId).metadata.internalSteps) {
    manager.progress({
      workspaceRoot,
      taskId,
      internalStepId: step.id,
      internalStepStatus: "done",
      message: `Completed ${step.title}.`,
      evidence: { kind: "test_result", summary: step.title },
    });
  }
  manager.completeTask({
    workspaceRoot,
    taskId,
    evidence: { kind: "test_result", summary: "Route completed." },
  });
  const finalized = manager.finalizeTurn({
    workspaceRoot,
    summaryId: "../../outside-summary",
    turnId: "../../outside-turn",
  });
  assert.equal(finalized.summary.id, "../../outside-summary");
  assert.equal(finalized.summary.turnId, "../../outside-turn");
  const summariesDir = path.join(
    workspaceRoot,
    ".codex",
    "overtli-task-manager",
    "summaries",
  );
  const files = fs.readdirSync(summariesDir);
  assert.equal(files.length, 2);
  for (const name of files)
    assert.match(name, /^summary-[a-f0-9]{24}\.(json|md)$/);
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, "outside-summary.json")),
    false,
  );
  assert.equal(fs.existsSync(path.join(workspaceRoot, "outside-turn")), false);
});

test("explicit AGENTS targets cannot escape the workspace", () => {
  const workspaceRoot = tempWorkspace("otm-agents-target-safe-");
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  assert.throws(
    () =>
      installWorkspace({
        workspaceRoot,
        packageRoot,
        targetAgentsFile: "../outside-agents.md",
        dryRun: true,
      }),
    { code: "PATH_TRAVERSAL" },
  );
  assert.throws(
    () =>
      installWorkspace({
        workspaceRoot,
        packageRoot,
        targetAgentsFile: fs.mkdtempSync(
          path.join(os.tmpdir(), "otm-agents-external-"),
        ),
        dryRun: true,
      }),
    { code: "PATH_ABSOLUTE_NOT_ALLOWED" },
  );
});

test("malformed JSON state is quarantined rather than normalized to an empty store", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "otm-json-corrupt-"));
  const statePath = path.join(stateDir, "state.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify({ schemaVersion: "otm.store.v1", runs: "not-an-array" }),
    "utf8",
  );
  const store = new JsonStore({ stateDir });
  assert.throws(
    () => store.init(),
    (error) =>
      error.code === "JSON_STORE_CORRUPTION" &&
      error.details.preserved === true,
  );
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(
    fs
      .readdirSync(stateDir)
      .some((name) => name.startsWith("state.json.corrupt-")),
    true,
  );
});

test("read-only JSON inspection reports malformed state without changing bytes or filesystem metadata", () => {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-readonly-corrupt-"),
  );
  const statePath = path.join(stateDir, "state.json");
  const bytes = '{"not":"closed"';
  fs.writeFileSync(statePath, bytes, "utf8");
  const before = fs.statSync(statePath);
  const entries = fs.readdirSync(stateDir).sort();
  assert.throws(() => new JsonStore({ stateDir, readOnly: true }).init(), {
    code: "JSON_STORE_CORRUPTION",
  });
  const after = fs.statSync(statePath);
  assert.equal(fs.readFileSync(statePath, "utf8"), bytes);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(stateDir).sort(), entries);
});

test("shared evidence redactor removes common cloud, JWT, private-key, and dotenv secret patterns", () => {
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nvery private material\n-----END PRIVATE KEY-----";
  const text = [
    "MY_DATABASE_URL=postgres://user:super-secret@example.test/db",
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz",
    "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
    "google=AIza123456789012345678901234567890",
    "slack=xoxb-1234567890-abcdefghijk",
    "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
    privateKey,
  ].join("\n");
  const redacted = redactSensitiveText(text);
  for (const secret of [
    "super-secret",
    "sk-proj-",
    "AKIAABCDEFGHIJKLMNOP",
    "AIza123",
    "xoxb-",
    "eyJhbGci",
    "very private material",
  ])
    assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /\[REDACTED/);
});
