import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProviderAdapter } from "../src/core/provider-adapter.mjs";
import { observeHostHook } from "../src/core/local-host-evidence.mjs";
import { findWorkspaceRoot, normalizeHostPath } from "../src/core/fs-utils.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const claudeHookScript = path.join(packageRoot, "hooks", "claude-code.mjs");
const hostModule = path.join(packageRoot, "src", "core", "local-host-evidence.mjs");

/** A workspace plus a real local host-evidence observer configuration. */
function realHost() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "otm-stop-reg-"));
  fs.mkdirSync(path.join(workspaceRoot, ".git"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "otm-stop-reg-state-"));
  const runtimeRoot = path.join(stateDir, "odc-runtime");
  const receiptRoot = path.join(stateDir, "host-evidence");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(receiptRoot, { recursive: true });
  for (const [name, value] of [
    ["process-jobs.json", { schema: 1, jobs: [] }],
    ["owned-processes.json", { schema: 1, processes: [] }],
    ["idempotency.json", []],
  ])
    fs.writeFileSync(path.join(runtimeRoot, name), JSON.stringify(value));
  const configPath = path.join(stateDir, "host-evidence.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      projectRoots: [workspaceRoot],
      odcRuntimeRoot: runtimeRoot,
      receiptRoot,
    }),
  );
  const env = {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: stateDir,
    OTM_HOST_EVIDENCE_CONFIG: configPath,
    OTM_AUTO_SYNC_AGENTS: "0",
  };
  const store = new JsonStore({ stateDir: path.join(stateDir, "json") });
  store.init();
  return {
    workspaceRoot,
    stateDir,
    receiptRoot,
    env,
    store,
    args: ["--host-evidence-module", hostModule],
  };
}

function hook(host, eventName, sessionId, extra = {}) {
  const result = spawnSync(
    process.execPath,
    [claudeHookScript, ...host.args],
    {
      cwd: host.workspaceRoot,
      env: host.env,
      input: JSON.stringify({
        session_id: sessionId,
        hook_event_name: eventName,
        cwd: host.workspaceRoot,
        ...extra,
      }),
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function context(result) {
  return result?.hookSpecificOutput?.additionalContext || "";
}

function coveragePath(host, sessionId) {
  const digest = crypto
    .createHash("sha256")
    .update(`claude\0${sessionId}`)
    .digest("hex");
  return path.join(host.receiptRoot, "owners", `${digest}.json`);
}

/** Start a route owned by the session and complete its only gate. */
function completedRoute(host, sessionId) {
  const owner = createProviderAdapter({
    provider: "claude",
    nativeSessionId: sessionId,
    workspaceRoot: host.workspaceRoot,
    env: host.env,
    store: host.store,
  });
  const route = owner.startTask({
    workspaceRoot: host.workspaceRoot,
    goal: "Regression route",
    tasks: [
      {
        title: "Only gate",
        internalSteps: [
          {
            title: "Verify only gate",
            source: "test_fixture",
            atomic: true,
            atomicRationale: "Single regression fixture step.",
          },
        ],
        metadata: {
          decomposition: {
            version: 2,
            source: "test_fixture",
            needsModelReview: false,
          },
        },
      },
    ],
  });
  const taskId = route.snapshot.tasks[0].id;
  owner.recordProgress({
    runId: route.run.id,
    taskId,
    internalStepIndex: 0,
    internalStepStatus: "done",
    message: "Fixture step verified.",
  });
  owner.completeTask({
    runId: route.run.id,
    taskId,
    evidence: { kind: "test_result", summary: "Fixture gate verified." },
  });
  return { owner, route };
}

const noBackground = { stop_hook_active: false, background_tasks: [], session_crons: [] };

test("Git Bash, Cygwin and WSL drive paths resolve to Windows paths", () => {
  assert.equal(normalizeHostPath("/d/AI/Overtli Projector", "win32"), "D:\\AI\\Overtli Projector");
  assert.equal(normalizeHostPath("/mnt/c/Users/x", "win32"), "C:\\Users\\x");
  assert.equal(normalizeHostPath("/cygdrive/e", "win32"), "E:\\");
  assert.equal(normalizeHostPath("D:\\AI", "win32"), "D:\\AI");
  assert.equal(normalizeHostPath("/home/user/repo", "win32"), "/home/user/repo");
  assert.equal(normalizeHostPath("/d/AI", "linux"), "/d/AI");
  if (process.platform === "win32") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "otm-posix-cwd-"));
    fs.mkdirSync(path.join(root, ".git"));
    const posix = `/${root[0].toLowerCase()}/${root.slice(3).split(path.sep).join("/")}`;
    assert.equal(findWorkspaceRoot(posix).toLowerCase(), root.toLowerCase());
  }
});

test("host identity failures name the exact mismatching field", () => {
  const sessionId = "claude-identity-mismatch-session";
  const host = realHost();
  const { owner, route } = completedRoute(host, sessionId);
  const run = host.store.getRun(route.run.id);
  const base = {
    schemaVersion: "otm.host-hook-observation.v1",
    provider: "claude",
    eventName: "Stop",
    payload: { session_id: sessionId, hook_event_name: "Stop" },
    nativeSessionId: sessionId,
    providerSessionKey: owner.session.providerSessionKey,
    sessionId: owner.session.sessionId,
    run,
    routeRevision: run.routeRevision,
  };
  const elsewhere = observeHostHook({
    ...base,
    workspaceRoot: path.join(host.workspaceRoot, "nested"),
  });
  assert.equal(elsewhere.code, "HOST_HOOK_IDENTITY_UNVERIFIED");
  assert.equal(elsewhere.mismatch, "workspaceRoot");
  const stale = observeHostHook({
    ...base,
    workspaceRoot: host.workspaceRoot,
    routeRevision: run.routeRevision - 1,
  });
  assert.equal(stale.mismatch, "routeRevision");
  owner.close();
});

test("Stop finalizes a complete route after the session cwd drifts into a nested repository", () => {
  const sessionId = "claude-nested-cwd-session";
  const host = realHost();
  hook(host, "SessionStart", sessionId, { source: "startup" });
  const { owner, route } = completedRoute(host, sessionId);
  const nested = path.join(host.workspaceRoot, "app-unity");
  fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
  // Context compaction re-runs SessionStart; it must not disturb coverage.
  hook(host, "SessionStart", sessionId, { source: "compact", cwd: nested });
  const stop = hook(host, "Stop", sessionId, { ...noBackground, cwd: nested });
  assert.equal(stop.decision, undefined, JSON.stringify(stop));
  assert.match(context(stop), /saved the canonical route summary/i);
  assert.equal(host.store.getRun(route.run.id).status, "cleared");
  owner.close();
});

test("SessionStart replay for an unknown session explains itself and records nothing", () => {
  const host = realHost();
  const unknown = "claude-unknown-replayed-session";
  const result = hook(host, "SessionStart", unknown, { source: "resume" });
  assert.match(context(result), /recorded nothing for Claude session/);
  assert.match(context(result), /ODC_OWNER_COVERAGE_LEGACY/);
  assert.equal(fs.existsSync(coveragePath(host, unknown)), false);
  assert.equal(host.store.listRuns?.().length ?? 0, 0);
  const files = fs.readdirSync(path.join(host.stateDir, "json"));
  const before = JSON.stringify(
    files.map((name) => [name, fs.statSync(path.join(host.stateDir, "json", name)).size]),
  );
  hook(host, "SessionStart", unknown, { source: "resume" });
  const after = JSON.stringify(
    fs
      .readdirSync(path.join(host.stateDir, "json"))
      .map((name) => [name, fs.statSync(path.join(host.stateDir, "json", name)).size]),
  );
  assert.equal(after, before, "a replay leaves no stray store state");
});

test("a route owner without startup coverage is told how to finish instead of a silent block", () => {
  const sessionId = "claude-no-startup-coverage-session";
  const host = realHost();
  const { owner, route } = completedRoute(host, sessionId);
  const resumed = hook(host, "SessionStart", sessionId, { source: "resume" });
  assert.match(context(resumed), new RegExp(`/otm continue ${route.run.id}`));
  const stop = hook(host, "Stop", sessionId, noBackground);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /ODC_OWNER_COVERAGE_(MISSING|LEGACY)/);
  assert.match(stop.reason, /begins only at a fresh SessionStart/);
  owner.close();
});

test("tool calls inside a running background subagent do not block Stop as unclassified work", () => {
  const sessionId = "claude-background-subagent-session";
  const host = realHost();
  hook(host, "SessionStart", sessionId, { source: "startup" });
  const { owner, route } = completedRoute(host, sessionId);
  hook(host, "SubagentStart", sessionId, { agent_id: "agent-bg-1", agent_type: "Explore" });
  hook(host, "PreToolUse", sessionId, {
    agent_id: "agent-bg-1",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_use_id: "toolu-inside-agent",
  });
  // A legacy receipt without agent_id: its owner is found in the subagent
  // transcript that issued the tool_use.
  hook(host, "PreToolUse", sessionId, {
    tool_name: "Read",
    tool_input: { file_path: "x" },
    tool_use_id: "toolu-legacy-inside-agent",
  });
  const transcript = path.join(host.stateDir, "main.jsonl");
  fs.writeFileSync(transcript, '{"type":"user","message":{"content":"hi"}}\n');
  fs.mkdirSync(path.join(host.stateDir, "main", "subagents"), { recursive: true });
  fs.writeFileSync(
    path.join(host.stateDir, "main", "subagents", "agent-agent-bg-1.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu-legacy-inside-agent", name: "Read", input: {} }],
      },
    })}\n`,
  );
  const running = hook(host, "Stop", sessionId, {
    ...noBackground,
    transcript_path: transcript,
    background_tasks: [
      { id: "agent-bg-1", status: "running" },
      { id: "bash-bg-1", status: "running" },
    ],
  });
  assert.equal(running.decision, undefined, JSON.stringify(running));
  assert.equal(running.continue, true);
  assert.notEqual(host.store.getRun(route.run.id).status, "cleared");

  // The subagent ends; its in-flight tool calls ended with it.
  hook(host, "SubagentStop", sessionId, {
    agent_id: "agent-bg-1",
    agent_type: "Explore",
    stop_hook_active: false,
  });
  const done = hook(host, "Stop", sessionId, { ...noBackground, transcript_path: transcript });
  assert.equal(done.decision, undefined, JSON.stringify(done));
  assert.match(context(done), /saved the canonical route summary/i);
  owner.close();
});

test("an unmatched receipt with no running Claude work blocks with its exact work id", () => {
  const sessionId = "claude-unmatched-receipt-session";
  const host = realHost();
  hook(host, "SessionStart", sessionId, { source: "startup" });
  const { owner } = completedRoute(host, sessionId);
  hook(host, "PreToolUse", sessionId, {
    tool_name: "Bash",
    tool_input: { command: "cancelled" },
    tool_use_id: "toolu-never-settled",
  });
  const stop = hook(host, "Stop", sessionId, noBackground);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /tool:toolu-never-settled/);
  assert.doesNotMatch(stop.reason, /unclassified background tasks/);
  owner.close();
});
