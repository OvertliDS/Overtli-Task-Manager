import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "../src/core/manager.mjs";
import { runHookScript } from "../src/hooks/runner.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";

for (const kind of ["json", "sqlite"]) {
  function setup(t, identity = "") {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `otm-owner-bootstrap-${kind}-`),
    );
    const workspaceRoot = path.join(root, "project");
    fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
    const env = {
      ...process.env,
      OTM_STORAGE: kind,
      OTM_STATE_DIR: root,
      OTM_SESSION_ID: "",
      CODEX_THREAD_ID: identity,
      OTM_HOST_EVIDENCE_MODULE: "",
      OTM_AUTO_SYNC_AGENTS: "0",
      OTM_DEDUPE_HOOKS: "0",
      OTM_TRACK_MCP_EVIDENCE: "0",
    };
    const store =
      kind === "json"
        ? new JsonStore({ stateDir: path.join(root, "json") })
        : new SqliteStore({ stateDir: root });
    store.init();
    t.after(() => store.close());
    const manager = createTaskManager({ cwd: workspaceRoot, env, store });
    const start = (sessionId) =>
      manager.start({
        sessionId,
        workspaceRoot,
        goal: "Owner bootstrap fixture",
        tasks: [
          {
            title: "Preserved gate",
            internalSteps: [
              {
                title: "One check",
                atomic: true,
                atomicRationale: "This case isolates owner provenance.",
              },
            ],
          },
        ],
      });
    return { manager, store, env, workspaceRoot, start };
  }

  test(`${kind}: native MCP starts bind only the trusted matching Codex session`, (t) => {
    const { start, store } = setup(t, "authentic-native-session");
    const current = start("authentic-native-session");
    const owner = store.getRun(current.run.id).metadata.providerSession;
    assert.equal(owner.provider, "codex");
    assert.equal(owner.nativeSessionId, "authentic-native-session");
    assert.throws(() => start("another-session"), {
      code: "SESSION_IDENTITY_CONFLICT",
    });
    const legacy = setup(t).start("explicit-unattested-id");
    assert.equal(legacy.run.metadata.providerSession, undefined);
  });

  test(`${kind}: an authentic resumed hook upgrades its exact legacy route without replacing gates`, async (t) => {
    const { start, store, env, workspaceRoot } = setup(t);
    const legacy = start("original-session");
    const before = JSON.stringify(store.getTasks(legacy.run.id));
    await runHookScript("session-start", {
      cwd: workspaceRoot,
      env,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: "original-session",
        hook_event_name: "SessionStart",
        source: "resume",
      }),
    });
    const upgraded = store.getRun(legacy.run.id);
    assert.equal(
      upgraded.metadata.providerSession.nativeSessionId,
      "original-session",
    );
    assert.equal(upgraded.sessionId, legacy.run.sessionId);
    assert.equal(JSON.stringify(store.getTasks(legacy.run.id)), before);
    const bootstrap = store
      .getEventSnapshot(legacy.run.id, 100)
      .events.filter((event) => event.payload?.ownerBoundByHost);
    assert.equal(bootstrap.length, 1);
    assert.equal(bootstrap[0].payload.activityKind, "SessionStart");
    assert.equal(
      store.getCanonicalBinding("original-session").currentRunId,
      legacy.run.id,
    );
    await runHookScript("session-start", {
      cwd: workspaceRoot,
      env,
      stdin: JSON.stringify({
        cwd: workspaceRoot,
        session_id: "original-session",
        hook_event_name: "SessionStart",
        source: "resume",
      }),
    });
    assert.equal(
      store
        .getEventSnapshot(legacy.run.id, 100)
        .events.filter((event) => event.payload?.ownerBoundByHost).length,
      1,
    );
  });

  test(`${kind}: owner bootstrap rejects aliases, stale revisions and a concurrent binding change`, (t) => {
    const { start, store, manager } = setup(t);
    const legacy = start("original-session");
    const args = {
      runId: legacy.run.id,
      sessionId: "original-session",
      officialSessionId: "original-session",
      expectedRevision: legacy.run.routeRevision,
      hookEventName: "PreToolUse",
    };
    assert.throws(
      () =>
        manager.bindCodexOwner({ ...args, officialSessionId: "other-session" }),
      { code: "HOST_SESSION_REQUIRED" },
    );
    assert.throws(
      () =>
        manager.bindCodexOwner({
          ...args,
          expectedRevision: legacy.run.routeRevision + 1,
        }),
      { code: "REVISION_CONFLICT" },
    );
    const realCommit = store.commitRunMutation.bind(store);
    store.commitRunMutation = (mutation) => {
      const binding = store.getCanonicalBinding("original-session");
      store.updateCanonicalBinding(
        { ...binding, currentRunId: null },
        { expectedRunId: legacy.run.id },
      );
      return realCommit(mutation);
    };
    assert.throws(() => manager.bindCodexOwner(args), {
      code: "CANONICAL_ROUTE_CONFLICT",
    });
    assert.equal(
      store.getRun(legacy.run.id).metadata.providerSession,
      undefined,
    );
    assert.equal(
      store.getRun(legacy.run.id).routeRevision,
      legacy.run.routeRevision,
    );
  });
}
