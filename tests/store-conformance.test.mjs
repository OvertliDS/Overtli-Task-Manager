import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonStore } from "../src/storage/json-store.mjs";
import {
  SqliteStore,
  loadBetterSqlite3,
} from "../src/storage/sqlite-store.mjs";

const NOW = "2026-01-01T00:00:00.000Z";

function stores() {
  const json = new JsonStore({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "otm-conformance-json-")),
  });
  json.init();
  const BetterSqlite3 = loadBetterSqlite3();
  assert.ok(
    BetterSqlite3,
    "better-sqlite3 is required for the SQLite conformance lane",
  );
  const sqlite = new SqliteStore({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "otm-conformance-sqlite-")),
  });
  sqlite.init();
  return [json, sqlite];
}

function seedRoute(store) {
  const run = {
    id: "run-1",
    workspaceRoot: "C:/workspace",
    sessionId: "session-1",
    turnId: null,
    promptHash: null,
    goal: "Conformance",
    status: "active",
    routeRevision: 1,
    currentTaskId: "task-1",
    createdAt: NOW,
    updatedAt: NOW,
    finalizedAt: null,
    metadata: {},
  };
  const task = {
    id: "task-1",
    runId: run.id,
    parentId: null,
    stableKey: "task",
    title: "Task",
    description: null,
    status: "active",
    required: true,
    priority: 50,
    sortOrder: 1,
    createdBy: "test",
    acceptanceCriteria: [],
    evidence: [],
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    metadata: {},
  };
  store.createRoute({
    run,
    tasks: [task],
    event: {
      id: "event-1",
      runId: run.id,
      turnId: null,
      hookEventName: null,
      eventType: "run_started",
      idempotencyKey: "start-1",
      payload: {},
      createdAt: NOW,
    },
  });
  return { run, task };
}

test("storage conformance: latest events are chronological and idempotent on both backends", () => {
  for (const store of stores()) {
    const { run } = seedRoute(store);
    store.recordEvent({
      id: "event-2",
      runId: run.id,
      turnId: null,
      hookEventName: null,
      eventType: "progress",
      idempotencyKey: "event-2",
      payload: {},
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    store.recordEvent({
      id: "event-3",
      runId: run.id,
      turnId: null,
      hookEventName: null,
      eventType: "progress",
      idempotencyKey: "event-3",
      payload: {},
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    store.recordEvent({
      id: "event-duplicate",
      runId: run.id,
      turnId: null,
      hookEventName: null,
      eventType: "progress",
      idempotencyKey: "event-3",
      payload: {},
      createdAt: "2026-01-04T00:00:00.000Z",
    });
    assert.deepEqual(
      store.getEvents(run.id, 2).map((event) => event.id),
      ["event-2", "event-3"],
    );
    store.close?.();
  }
});

test("storage conformance: tag deletion removes only matching cache entries on both backends", () => {
  for (const store of stores()) {
    const workspaceRoot = "C:/workspace";
    for (const [id, tags] of [
      ["cache-a", ["keep"]],
      ["cache-b", ["remove"]],
      ["cache-c", ["remove", "keep"]],
    ]) {
      store.upsertCache({
        id,
        workspaceRoot,
        kind: "note",
        title: id,
        body: id,
        tags,
        source: {},
        scoreHint: 0,
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: null,
      });
    }
    assert.equal(store.deleteCache({ workspaceRoot, tag: "remove" }), 2);
    assert.deepEqual(
      store.listCache(workspaceRoot, 10).map((entry) => entry.id),
      ["cache-a"],
    );
    store.close?.();
  }
});

test("storage conformance: cache upserts retain createdAt while updating mutable fields on both backends", () => {
  for (const store of stores()) {
    const initial = {
      id: "cache-preserve-created",
      workspaceRoot: "C:/workspace",
      kind: "note",
      title: "Initial",
      body: "Initial",
      tags: ["first"],
      source: {},
      scoreHint: 0,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: null,
    };
    store.upsertCache(initial);
    const updated = store.upsertCache({
      ...initial,
      title: "Updated",
      tags: ["second"],
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.equal(updated.createdAt, NOW);
    assert.deepEqual(store.listCache(initial.workspaceRoot, 10), [
      {
        ...initial,
        title: "Updated",
        tags: ["second"],
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    store.close?.();
  }
});

test("storage conformance: revision conflicts reject stale compound mutations on both backends", () => {
  for (const store of stores()) {
    const { run, task } = seedRoute(store);
    const nextRun = {
      ...run,
      routeRevision: 2,
      status: "ready_to_finalize",
      currentTaskId: null,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const nextTask = {
      ...task,
      status: "done",
      completedAt: nextRun.updatedAt,
      updatedAt: nextRun.updatedAt,
    };
    store.commitRunMutation({
      run: nextRun,
      expectedRevision: 1,
      tasks: [nextTask],
      event: {
        id: "event-complete",
        runId: run.id,
        turnId: null,
        hookEventName: null,
        eventType: "task_completed",
        idempotencyKey: "complete-1",
        payload: {},
        createdAt: nextRun.updatedAt,
      },
    });
    assert.throws(
      () =>
        store.commitRunMutation({
          run: { ...nextRun, routeRevision: 3 },
          expectedRevision: 1,
        }),
      { code: "REVISION_CONFLICT" },
    );
    assert.equal(store.getRun(run.id).routeRevision, 2);
    store.close?.();
  }
});

test("storage conformance: expiry selector deletes only expired cache entries on both backends", () => {
  for (const store of stores()) {
    const workspaceRoot = "C:/workspace";
    store.upsertCache({
      id: "expired",
      workspaceRoot,
      kind: "note",
      title: "Expired",
      body: "Expired",
      tags: [],
      source: {},
      scoreHint: 0,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: "2025-12-31T00:00:00.000Z",
    });
    store.upsertCache({
      id: "current",
      workspaceRoot,
      kind: "note",
      title: "Current",
      body: "Current",
      tags: [],
      source: {},
      scoreHint: 0,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: "2026-12-31T00:00:00.000Z",
    });
    assert.equal(
      store.deleteCache({ workspaceRoot, expired: true, now: NOW }),
      1,
    );
    assert.deepEqual(
      store.listCache(workspaceRoot, 10).map((entry) => entry.id),
      ["current"],
    );
    store.close?.();
  }
});

test("storage conformance: empty cache selectors are rejected and expired entries remain explicit", () => {
  for (const store of stores()) {
    const workspaceRoot = "C:/workspace";
    store.upsertCache({
      id: "expired",
      workspaceRoot,
      kind: "note",
      title: "Expired",
      body: "Expired",
      tags: [],
      source: {},
      scoreHint: 0,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: "2025-12-31T00:00:00.000Z",
    });
    assert.throws(() => store.deleteCache({}), {
      code: "CACHE_SELECTOR_REQUIRED",
    });
    assert.deepEqual(
      store.listCache(workspaceRoot, 10).map((entry) => entry.id),
      ["expired"],
    );
    assert.equal(
      store.deleteCache({ workspaceRoot, expired: true, now: NOW }),
      1,
    );
    store.close?.();
  }
});

test("storage conformance: terminal workspace export/import is atomic and rejects collisions on both backends", () => {
  for (const source of stores()) {
    const { run, task } = seedRoute(source);
    const finalizedAt = "2026-01-02T00:00:00.000Z";
    source.commitRunMutation({
      run: {
        ...run,
        status: "completed",
        currentTaskId: null,
        routeRevision: 2,
        finalizedAt,
        updatedAt: finalizedAt,
      },
      expectedRevision: 1,
      tasks: [
        {
          ...task,
          status: "done",
          completedAt: finalizedAt,
          updatedAt: finalizedAt,
        },
      ],
      summaries: [
        {
          id: "summary-1",
          runId: run.id,
          workspaceRoot: run.workspaceRoot,
          turnId: null,
          summaryMd: "Summary",
          summaryJson: { status: "completed" },
          currentCleared: false,
          createdAt: finalizedAt,
        },
      ],
      event: {
        id: "event-finalized",
        runId: run.id,
        turnId: null,
        hookEventName: null,
        eventType: "turn_finalized",
        idempotencyKey: "finalized-1",
        payload: {},
        createdAt: finalizedAt,
      },
    });
    source.upsertCache({
      id: "cache-export",
      workspaceRoot: run.workspaceRoot,
      kind: "note",
      title: "Exported",
      body: "Exported",
      tags: ["export"],
      source: {},
      scoreHint: 0,
      createdAt: NOW,
      updatedAt: finalizedAt,
      expiresAt: null,
    });
    const payload = source.exportWorkspace(run.workspaceRoot);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [key, value.length]),
      ),
      { runs: 1, tasks: 1, events: 2, summaries: 1, cache: 1 },
    );
    const target =
      source.kind === "json"
        ? new JsonStore({
            stateDir: fs.mkdtempSync(
              path.join(os.tmpdir(), "otm-import-json-"),
            ),
          })
        : new SqliteStore({
            stateDir: fs.mkdtempSync(
              path.join(os.tmpdir(), "otm-import-sqlite-"),
            ),
          });
    target.init();
    assert.deepEqual(target.importWorkspace(payload), {
      runs: 1,
      tasks: 1,
      events: 2,
      summaries: 1,
      cache: 1,
    });
    assert.equal(target.getRun(run.id).status, "completed");
    assert.equal(
      target.listSummaries(run.workspaceRoot, 10)[0].id,
      "summary-1",
    );
    assert.throws(() => target.importWorkspace(payload), {
      code: "IMPORT_CONFLICT",
    });
    source.close?.();
    target.close?.();
  }
});

test("JSON store replacement and direct task helpers retain existing data and records", () => {
  const store = new JsonStore({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "otm-json-helper-")),
  });
  store.init();
  const { run } = seedRoute(store);
  const replacement = {
    ...run,
    id: "run-2",
    routeRevision: 1,
    currentTaskId: "task-2",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
  const replacementTask = {
    ...store.getTask("task-1"),
    id: "task-2",
    runId: replacement.id,
    stableKey: "task-2",
    createdAt: replacement.createdAt,
    updatedAt: replacement.updatedAt,
  };
  store.createRoute({
    run: replacement,
    tasks: [replacementTask],
    event: {
      id: "event-2",
      runId: replacement.id,
      turnId: null,
      hookEventName: null,
      eventType: "run_started",
      idempotencyKey: "start-2",
      payload: {},
      createdAt: replacement.createdAt,
    },
    replaceRunId: run.id,
  });
  assert.equal(store.getRun(run.id).status, "abandoned");
  const added = {
    ...replacementTask,
    id: "task-3",
    stableKey: "task-3",
    sortOrder: 2,
  };
  store.addTasks([added]);
  assert.equal(
    store.updateTask(added.id, { title: "Updated task" }).title,
    "Updated task",
  );
  assert.equal(store.updateTask("missing-task", { title: "missing" }), null);
  store.close();
});

test("storage conformance: active scope replacement preserves one scoped active route and task ordering", () => {
  for (const store of stores()) {
    const { run, task } = seedRoute(store);
    const competingRun = {
      ...run,
      id: "run-competing",
      currentTaskId: "task-competing",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const competingTask = {
      ...task,
      id: "task-competing",
      runId: competingRun.id,
      stableKey: "competing",
      sortOrder: 2,
      createdAt: competingRun.createdAt,
      updatedAt: competingRun.updatedAt,
    };
    assert.throws(
      () =>
        store.createRoute({
          run: competingRun,
          tasks: [competingTask],
          event: {
            id: "event-competing",
            runId: competingRun.id,
            turnId: null,
            hookEventName: null,
            eventType: "run_started",
            idempotencyKey: "competing",
            payload: {},
            createdAt: competingRun.createdAt,
          },
        }),
      { code: "ACTIVE_ROUTE_CONFLICT" },
    );
    const replacement = {
      ...competingRun,
      id: "run-replacement",
      currentTaskId: "task-replacement",
    };
    const replacementTask = {
      ...competingTask,
      id: "task-replacement",
      runId: replacement.id,
      stableKey: "replacement",
    };
    store.createRoute({
      run: replacement,
      tasks: [
        replacementTask,
        {
          ...replacementTask,
          id: "task-replacement-first",
          stableKey: "replacement-first",
          sortOrder: 1,
        },
      ],
      event: {
        id: "event-replacement",
        runId: replacement.id,
        turnId: null,
        hookEventName: null,
        eventType: "run_started",
        idempotencyKey: "replacement",
        payload: {},
        createdAt: replacement.createdAt,
      },
      replaceRunId: run.id,
    });
    assert.equal(store.getRun(run.id).status, "abandoned");
    assert.equal(
      store.getActiveRun(run.workspaceRoot, run.sessionId).id,
      replacement.id,
    );
    assert.deepEqual(
      store.getTasks(replacement.id).map((item) => item.id),
      ["task-replacement-first", "task-replacement"],
    );
    store.close?.();
  }
});

test("storage conformance: summary upsert and history pruning preserve active routes", () => {
  for (const store of stores()) {
    const { run, task } = seedRoute(store);
    const oldRun = {
      ...run,
      id: "run-old",
      sessionId: "old-session",
      status: "completed",
      currentTaskId: null,
      routeRevision: 1,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      finalizedAt: "2020-01-01T00:00:00.000Z",
    };
    const oldTask = {
      ...task,
      id: "task-old",
      runId: oldRun.id,
      stableKey: "old",
      status: "done",
      completedAt: oldRun.finalizedAt,
      createdAt: oldRun.createdAt,
      updatedAt: oldRun.updatedAt,
    };
    store.createRoute({
      run: oldRun,
      tasks: [oldTask],
      event: {
        id: "event-old",
        runId: oldRun.id,
        turnId: null,
        hookEventName: null,
        eventType: "run_started",
        idempotencyKey: "old-start",
        payload: {},
        createdAt: oldRun.createdAt,
      },
    });
    const summary = {
      id: "summary-upsert",
      runId: run.id,
      workspaceRoot: run.workspaceRoot,
      turnId: null,
      summaryMd: "first",
      summaryJson: { first: true },
      currentCleared: false,
      createdAt: NOW,
    };
    store.upsertSummary(summary);
    store.upsertSummary({
      ...summary,
      summaryMd: "updated",
      currentCleared: true,
    });
    assert.deepEqual(
      store
        .listSummaries(run.workspaceRoot, 10)
        .filter((item) => item.id === summary.id),
      [{ ...summary, summaryMd: "updated", currentCleared: true }],
    );
    const pruned = store.pruneHistory({
      workspaceRoot: run.workspaceRoot,
      olderThan: "2021-01-01T00:00:00.000Z",
      now: NOW,
      retentionDays: 365,
      dryRun: false,
    });
    assert.equal(pruned.deleted.runs, 1);
    assert.equal(store.getRun(oldRun.id), null);
    assert.equal(store.getRun(run.id).id, run.id);
    store.close?.();
  }
});
