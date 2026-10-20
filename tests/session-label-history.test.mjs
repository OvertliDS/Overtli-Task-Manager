import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProviderAdapter } from "../src/core/provider-adapter.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";

function task(id, title = id, dependsOn = []) {
  return {
    id,
    title,
    dependsOn,
    internalSteps: [
      {
        title: `Check ${title}`,
        atomic: true,
        atomicRationale: "This fixture isolates shared route identity.",
      },
    ],
  };
}

for (const kind of ["json", "sqlite"]) {
  function setup(t) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `otm-label-history-${kind}-`),
    );
    const workspaceRoot = path.join(root, "project");
    fs.mkdirSync(workspaceRoot);
    const store =
      kind === "json"
        ? new JsonStore({ stateDir: path.join(root, "json") })
        : new SqliteStore({ stateDir: root });
    store.init();
    t.after(() => store.close());
    const adapter = (provider, nativeSessionId, workspace = workspaceRoot) =>
      createProviderAdapter({
        provider,
        nativeSessionId,
        workspaceRoot: workspace,
        store,
        env: { ...process.env, OTM_SESSION_ID: "", CODEX_THREAD_ID: "" },
      });
    return { root, workspaceRoot, store, adapter };
  }

  test(`${kind}: independent sessions reuse gate labels without corrupting owners or dependencies`, (t) => {
    const { adapter, store } = setup(t);
    const codex = adapter("codex", "older-owner");
    const old = codex.startTask({
      goal: "Existing task",
      tasks: [task("G1"), task("G2", "Second gate", ["G1"])],
    });
    const oldBytes = JSON.stringify(store.getTasks(old.run.id));
    const claude = adapter("claude", "independent-owner");
    const current = claude.startTask({
      goal: "Independent task",
      tasks: [task("G1"), task("G2", "Second gate", ["G1"])],
    });
    assert.notEqual(current.run.id, old.run.id);
    const gates = store.getTasks(current.run.id);
    assert.notEqual(gates[0].id, "G1");
    assert.equal(gates[0].metadata.requestedTaskId, "G1");
    assert.deepEqual(gates[1].metadata.dependsOn, [gates[0].id]);
    assert.equal(current.run.currentTaskId, gates[0].id);
    assert.equal(claude.snapshot().run.id, current.run.id);
    assert.equal(codex.snapshot().run.id, old.run.id);
    assert.equal(JSON.stringify(store.getTasks(old.run.id)), oldBytes);
    const added = claude.reconcileTask({
      runId: current.run.id,
      mode: "steer",
      changes: [{ action: "add", ...task("G1", "New explicit requirement") }],
    });
    assert.equal(
      store
        .getTasks(added.run.id)
        .filter((gate) => gate.metadata.requestedTaskId === "G1").length,
      2,
    );
    assert.equal(JSON.stringify(store.getTasks(old.run.id)), oldBytes);
  });

  test(`${kind}: a concurrent commit of the same labels retries once using the canonical winner`, (t) => {
    const { adapter, store } = setup(t);
    const realCreate = store.createRoute.bind(store);
    let injected = false;
    store.createRoute = (creation) => {
      if (!injected) {
        injected = true;
        adapter("codex", "concurrent-owner").startTask({
          goal: "Concurrent task",
          tasks: [task("G1")],
        });
      }
      return realCreate(creation);
    };
    const current = adapter("claude", "new-owner").startTask({
      goal: "Claude task",
      tasks: [task("G1")],
    });
    assert.equal(
      store.getTasks(current.run.id)[0].metadata.requestedTaskId,
      "G1",
    );
    assert.equal(store.listRuns(null, 10).length, 2);
  });

  test(`${kind}: shared history stays bounded, pages old workspaces and streams exact saved summaries`, (t) => {
    const { adapter, store, root } = setup(t);
    const otherWorkspace = path.join(root, "older-project");
    fs.mkdirSync(otherWorkspace);
    const owner = adapter("codex", "old-project-owner", otherWorkspace);
    const original = owner.startTask({
      goal: "Historical task",
      tasks: [task("G1")],
    });
    const text = "canonical saved summary\n".repeat(20_000);
    store.upsertSummary({
      id: "large-summary",
      runId: original.run.id,
      workspaceRoot: otherWorkspace,
      createdAt: new Date().toISOString(),
      summaryMd: text,
      summaryJson: { privateLargeSource: text },
    });
    for (let index = 0; index < 11; index++) {
      adapter("codex", `owner-${index}`).startTask({
        goal: `Other task ${index}`,
        tasks: [task("G1")],
      });
    }
    const reader = adapter("claude", "history-reader");
    const before = JSON.stringify(store.getRun(original.run.id));
    const first = reader.readSharedHistory({ limit: 50 });
    assert.ok(JSON.stringify(first).length < 20_000);
    assert.equal(first.runs.length, 10);
    assert.equal(first.nextOffset, 10);
    const second = reader.readSharedHistory({ offset: first.nextOffset });
    assert.equal(second.runs.length, 2);
    assert.equal(
      new Set([...first.runs, ...second.runs].map((run) => run.id)).size,
      12,
    );
    assert.ok(
      [...first.runs, ...second.runs].some((run) => run.id === original.run.id),
    );
    assert.ok(!JSON.stringify(first).includes("privateLargeSource"));
    assert.equal(
      reader.readSharedTask({ runId: original.run.id }).run.id,
      original.run.id,
    );
    const summary = reader.readSharedHistory({
      runId: original.run.id,
      summaryId: "large-summary",
      maxChars: 1000,
    });
    assert.equal(summary.summary.text, text.slice(0, 1000));
    assert.equal(summary.summary.nextOffset, 1000);
    const next = reader.readSharedHistory({
      runId: original.run.id,
      summaryId: "large-summary",
      offset: 1000,
      maxChars: 1000,
    });
    assert.equal(next.summary.text, text.slice(1000, 2000));
    assert.equal(JSON.stringify(store.getRun(original.run.id)), before);
    assert.equal(
      reader.readSharedHistory({ scope: "workspace" }).summaries.length,
      0,
    );
    const cli = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../bin/otm.mjs", import.meta.url)),
        "shared-history",
        "--run-id",
        original.run.id,
        "--summary-id",
        "large-summary",
        "--offset",
        "5",
        "--max-chars",
        "80",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OTM_STORAGE: kind,
          OTM_STATE_DIR: root,
          OTM_SESSION_ID: "",
          CODEX_THREAD_ID: "",
        },
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).summary.text, text.slice(5, 85));
  });
}
