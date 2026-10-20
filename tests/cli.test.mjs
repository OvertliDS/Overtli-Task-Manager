import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTaskManager } from "../src/core/manager.mjs";
import { currentJsonPath } from "../src/core/fs-utils.mjs";
import { handleCli } from "../src/cli/commands.mjs";
import { createProviderSession } from "../src/core/provider-session.mjs";

function tempWorkspace(prefix = "otm-cli-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Test Workspace\n", "utf8");
  return root;
}

async function capture(fn) {
  const original = console.log;
  const output = [];
  console.log = (value) => output.push(String(value));
  try {
    await fn();
    return output;
  } finally {
    console.log = original;
  }
}

test("CLI help and version are store-free and flags are strict", async () => {
  const workspaceRoot = tempWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "otm-cli-state-"));
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const output = await capture(async () => {
    await handleCli({
      argv: ["help"],
      cwd: workspaceRoot,
      stdin: "",
      packageRoot,
      env: { ...process.env, OTM_STATE_DIR: stateDir },
    });
    await handleCli({
      argv: ["version"],
      cwd: workspaceRoot,
      stdin: "",
      packageRoot,
      env: { ...process.env, OTM_STATE_DIR: stateDir },
    });
  });
  assert.equal(fs.readdirSync(stateDir).length, 0);
  assert.match(output.join("\n"), /Overtli Task Manager/);
  assert.match(
    output.join("\n"),
    /otm abandon --run-id ID --reason TEXT --confirm/,
  );
  await assert.rejects(
    () =>
      handleCli({
        argv: ["doctor", "--not-a-real-flag"],
        cwd: workspaceRoot,
        stdin: "",
        packageRoot,
        env: { ...process.env, OTM_STATE_DIR: stateDir },
      }),
    /Unknown flag/,
  );
  await assert.rejects(
    () =>
      handleCli({
        argv: ["list-runs", "--limit=not-a-number"],
        cwd: workspaceRoot,
        stdin: "",
        packageRoot,
        env: { ...process.env, OTM_STATE_DIR: stateDir },
      }),
    /--limit must be an integer/,
  );
});

test("Codex shared CLI reads the canonical Claude route and explicitly continues it", async () => {
  const workspaceRoot = tempWorkspace("otm-shared-cli-workspace-");
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-shared-cli-state-"),
  );
  const observerPath = path.join(stateDir, "trusted-host-inspector.mjs");
  fs.writeFileSync(
    observerPath,
    `import crypto from "node:crypto";
export function inspectOwnerWork(input) {
  const observedAt = new Date().toISOString();
  const ownerSessionId = input.ownerSession.nativeSessionId;
  const sources = input.requiredSources.map((id) => ({
    id, status: "complete", ownerSessionId, observedAt,
    activeWorkCount: 0, unknownWorkCount: 0,
    evidenceRefs: [{
      recordId: id + ":current-owner",
      ownerSessionId, observedAt,
      path: "fixture://" + id,
      sha256: crypto.createHash("sha256").update(id).digest("hex"),
    }],
  }));
  return {
    schemaVersion: "otm.host-continuation-evidence.v1",
    complete: true, runId: input.runId, routeRevision: input.routeRevision,
    owner: input.ownerSession, lastActivityAt: input.activityAt,
    activityEventId: input.activityEventId, observedAt,
    activeWorkCount: 0, unknownWorkCount: 0, blockers: [], sources,
  };
}
`,
  );
  const receivingSessionId = "codex-shared-cli-recipient";
  const env = {
    ...process.env,
    CODEX_THREAD_ID: receivingSessionId,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: stateDir,
    OTM_HOST_EVIDENCE_MODULE: observerPath,
  };
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const ownerEnv = { ...env };
  delete ownerEnv.CODEX_THREAD_ID;
  const manager = createTaskManager({ cwd: workspaceRoot, env: ownerEnv });
  const claude = createProviderSession({
    provider: "claude",
    nativeSessionId: "claude-shared-cli-owner",
  });
  const route = manager.start({
    workspaceRoot,
    sessionId: claude.sessionId,
    providerContext: { ...claude, nativeSessionId: "claude-shared-cli-owner" },
    goal: "Continue one canonical route across providers",
    prompt: "Expose the route to another provider without copying its history.",
    tasks: [
      {
        title: "Continue the shared route",
        internalSteps: [
          {
            title: "Verify shared route ownership transfer",
            source: "test_fixture",
            atomic: true,
            atomicRationale: "Exercise the Codex CLI continuation entry point.",
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
  const activityAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const activity = {
    id: `activity-${crypto.randomUUID()}`,
    runId: route.run.id,
    turnId: null,
    hookEventName: "SessionEnd",
    eventType: "provider_session_activity",
    idempotencyKey: `activity-${crypto.randomUUID()}`,
    payload: {
      ownerSessionId: claude.sessionId,
      providerSessionKey: claude.providerSessionKey,
      provider: "claude",
      nativeSessionId: "claude-shared-cli-owner",
      activityKind: "SessionEnd",
    },
    createdAt: activityAt,
  };
  manager.store.recordEvent(activity);
  manager.close();

  const sharedHistory = JSON.parse(
    (
      await capture(() =>
        handleCli({
          argv: ["shared-history", "--workspace", workspaceRoot, "--json"],
          cwd: workspaceRoot,
          stdin: "",
          packageRoot,
          env,
        }),
      )
    ).at(-1),
  );
  assert.equal(sharedHistory.runs[0].id, route.run.id);
  assert.equal(
    sharedHistory.runs[0].metadata.providerSession.provider,
    "claude",
  );
  assert.equal(
    JSON.stringify(sharedHistory).includes("claude-shared-cli-owner"),
    false,
  );
  assert.equal(
    JSON.stringify(sharedHistory).includes("providerSessionKey"),
    false,
  );

  const sharedTask = JSON.parse(
    (
      await capture(() =>
        handleCli({
          argv: [
            "shared-task",
            "--run-id",
            route.run.id,
            "--workspace",
            workspaceRoot,
            "--json",
          ],
          cwd: workspaceRoot,
          stdin: "",
          packageRoot,
          env,
        }),
      )
    ).at(-1),
  );
  assert.equal(sharedTask.run.id, route.run.id);
  assert.equal(sharedTask.run.sessionId, undefined);

  await assert.rejects(
    () =>
      handleCli({
        argv: [
          "continue-task",
          "--run-id",
          route.run.id,
          "--expected-revision",
          String(route.run.routeRevision),
          "--session-id",
          "claude-shared-cli-owner",
          "--workspace",
          workspaceRoot,
        ],
        cwd: workspaceRoot,
        stdin: "",
        packageRoot,
        env,
      }),
    /does not accept --session-id/,
  );

  await capture(() =>
    handleCli({
      argv: [
        "continue-task",
        "--run-id",
        route.run.id,
        "--expected-revision",
        String(route.run.routeRevision),
        "--workspace",
        workspaceRoot,
        "--json",
      ],
      cwd: workspaceRoot,
      stdin: "",
      packageRoot,
      env,
    }),
  );
  const verify = createTaskManager({ cwd: workspaceRoot, env });
  const transferred = verify.snapshot({
    workspaceRoot,
    sessionId: receivingSessionId,
    write: false,
  });
  assert.equal(transferred.run.id, route.run.id);
  assert.equal(transferred.run.metadata.providerSession.provider, "codex");
  assert.equal(
    transferred.run.metadata.providerSession.nativeSessionId,
    receivingSessionId,
  );
  verify.close();
});

test("CLI doctor reports malformed state and raw consistency issues without mutation", async () => {
  const workspaceRoot = tempWorkspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-cli-doctor-state-"),
  );
  const jsonDir = path.join(stateDir, "json");
  fs.mkdirSync(jsonDir, { recursive: true });
  const statePath = path.join(jsonDir, "state.json");
  fs.writeFileSync(statePath, "{ malformed", "utf8");
  const before = fs.statSync(statePath);
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const malformed = JSON.parse(
    (
      await capture(() =>
        handleCli({
          argv: ["doctor", "--json"],
          cwd: workspaceRoot,
          stdin: "",
          packageRoot,
          env: { ...process.env, OTM_STORAGE: "json", OTM_STATE_DIR: stateDir },
        }),
      )
    ).at(-1),
  );
  assert.equal(malformed.ok, false);
  assert.equal(
    malformed.checks.find((check) => check.name === "json-state").status,
    "error",
  );
  assert.equal(fs.statSync(statePath).mtimeMs, before.mtimeMs);
  assert.equal(
    fs.readdirSync(jsonDir).some((name) => name.includes("corrupt")),
    false,
  );

  fs.writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: "otm.store.v1",
      runs: [
        { id: "run-a", workspaceRoot, sessionId: "same", status: "active" },
        {
          id: "run-b",
          workspaceRoot: workspaceRoot.toUpperCase(),
          sessionId: "same",
          status: "blocked",
        },
      ],
      tasks: [{ id: "orphan-task", runId: "none", status: "pending" }],
      events: [],
      summaries: [],
      cache: [],
    }),
    "utf8",
  );
  fs.mkdirSync(path.dirname(currentJsonPath(workspaceRoot)), {
    recursive: true,
  });
  fs.writeFileSync(
    currentJsonPath(workspaceRoot),
    JSON.stringify({ activeSessionCount: 2 }),
    "utf8",
  );
  const inconsistent = JSON.parse(
    (
      await capture(() =>
        handleCli({
          argv: ["doctor", "--json"],
          cwd: workspaceRoot,
          stdin: "",
          packageRoot,
          env: { ...process.env, OTM_STORAGE: "json", OTM_STATE_DIR: stateDir },
        }),
      )
    ).at(-1),
  );
  assert.equal(
    inconsistent.checks.find((check) => check.name === "active-scopes").status,
    "error",
  );
  assert.equal(
    inconsistent.checks.find((check) => check.name === "references").status,
    "error",
  );
  assert.equal(
    inconsistent.checks.find((check) => check.name === "snapshot-index").status,
    "warning",
  );
  for (const [sessionId, status] of [
    ["session-one", "active"],
    ["session-two", "blocked"],
  ]) {
    const sessionCurrentPath = currentJsonPath(workspaceRoot, sessionId);
    fs.mkdirSync(path.dirname(sessionCurrentPath), { recursive: true });
    fs.writeFileSync(
      sessionCurrentPath,
      JSON.stringify({
        schemaVersion: "otm.current.v1",
        status,
        runId: `run-${sessionId}`,
        sessionId,
      }),
      "utf8",
    );
  }
  const consistentSnapshots = JSON.parse(
    (
      await capture(() =>
        handleCli({
          argv: ["doctor", "--json"],
          cwd: workspaceRoot,
          stdin: "",
          packageRoot,
          env: { ...process.env, OTM_STORAGE: "json", OTM_STATE_DIR: stateDir },
        }),
      )
    ).at(-1),
  );
  assert.equal(
    consistentSnapshots.checks.find((check) => check.name === "snapshot-index")
      .status,
    "ok",
  );

  const lockPath = path.join(jsonDir, "state.lock");
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: -1,
      operation: "seeded stale lock",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  const staleLock = JSON.parse(
    (
      await capture(() =>
        handleCli({
          argv: ["doctor", "--json"],
          cwd: workspaceRoot,
          stdin: "",
          packageRoot,
          env: { ...process.env, OTM_STORAGE: "json", OTM_STATE_DIR: stateDir },
        }),
      )
    ).at(-1),
  );
  const lockCheck = staleLock.checks.find(
    (check) => check.name === "json-lock",
  );
  assert.equal(lockCheck.status, "warning");
  assert.match(lockCheck.detail, /Stale-looking lock/);
});

test("CLI dry-run commands never initialize or rewrite JSON storage", async () => {
  const workspaceRoot = tempWorkspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-cli-dry-run-state-"),
  );
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const env = { ...process.env, OTM_STORAGE: "json", OTM_STATE_DIR: stateDir };
  await capture(() =>
    handleCli({
      argv: [
        "export",
        "--output",
        path.join(workspaceRoot, "export.json"),
        "--dry-run",
      ],
      cwd: workspaceRoot,
      stdin: "",
      packageRoot,
      env,
    }),
  );
  await capture(() =>
    handleCli({
      argv: ["cleanup", "--dry-run"],
      cwd: workspaceRoot,
      stdin: "",
      packageRoot,
      env,
    }),
  );
  assert.equal(fs.readdirSync(stateDir).length, 0);
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  manager.start({
    workspaceRoot,
    goal: "Dry-run history",
    tasks: [{ title: "Leave active" }],
  });
  const statePath = path.join(stateDir, "json", "state.json");
  const backupPath = `${statePath}.backup`;
  const before = fs.statSync(statePath);
  const backupBefore = fs.readFileSync(backupPath, "utf8");
  await capture(() =>
    handleCli({
      argv: ["prune-history", "--dry-run"],
      cwd: workspaceRoot,
      stdin: "",
      packageRoot,
      env,
    }),
  );
  assert.equal(fs.statSync(statePath).mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(backupPath, "utf8"), backupBefore);
});

test("CLI abandon requires explicit run, reason, and confirmation before clearing unfinished work", async () => {
  const workspaceRoot = tempWorkspace();
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otm-cli-abandon-state-"),
  );
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const env = {
    ...process.env,
    OTM_STORAGE: "json",
    OTM_STATE_DIR: stateDir,
    CODEX_THREAD_ID: "abandon-session",
  };
  const manager = createTaskManager({ cwd: workspaceRoot, env });
  const started = manager.start({
    workspaceRoot,
    goal: "Unfinished route",
    tasks: [{ title: "Open work" }],
  });
  await assert.rejects(
    () =>
      handleCli({
        argv: ["abandon", "--run-id", started.run.id, "--reason", "No access"],
        cwd: workspaceRoot,
        stdin: "",
        packageRoot,
        env,
      }),
    /--confirm/,
  );
  await capture(() =>
    handleCli({
      argv: [
        "abandon",
        "--run-id",
        started.run.id,
        "--reason",
        "No access",
        "--confirm",
        "--json",
      ],
      cwd: workspaceRoot,
      stdin: "",
      packageRoot,
      env,
    }),
  );
  assert.equal(manager.store.getRun(started.run.id).status, "abandoned");
});
