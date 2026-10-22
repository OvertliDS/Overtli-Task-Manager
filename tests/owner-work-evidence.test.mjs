import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPendingWorkEntries } from "../src/core/continuation.mjs";
import { createProviderAdapter } from "../src/core/provider-adapter.mjs";
import {
  compactOwnerWorkEvents,
  readOwnerWorkEvidence,
} from "../src/core/work-evidence.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";
import { SqliteStore } from "../src/storage/sqlite-store.mjs";

const OWNER = { ownerSessionId: "owner-session", providerSessionKey: "claude:owner" };
const OTHER = { ownerSessionId: "other-session", providerSessionKey: "claude:other" };

function createStore(kind) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `otm-work-${kind}-`));
  const store =
    kind === "sqlite" ? new SqliteStore({ stateDir }) : new JsonStore({ stateDir });
  store.init();
  return store;
}

/** A real route row so stores accept its events. */
function createRoute(store, kind) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "otm-work-ws-"));
  fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
  const adapter = createProviderAdapter({
    provider: "claude",
    nativeSessionId: `claude-work-evidence-${kind}`,
    workspaceRoot,
    env: { ...process.env, OTM_STORAGE: kind },
    store,
  });
  return adapter.startTask({
    workspaceRoot,
    goal: "Owner work evidence",
    tasks: [{ title: "Evidence gate" }],
  }).run.id;
}

function makeEvent(runId, index, eventType, owner, workId) {
  const payload = {
    ownerSessionId: owner.ownerSessionId,
    providerSessionKey: owner.providerSessionKey,
  };
  if (workId !== undefined) payload.workId = workId;
  return {
    id: `evt-${String(index).padStart(6, "0")}`,
    runId,
    turnId: null,
    hookEventName: "PreToolUse",
    eventType,
    idempotencyKey: `key-${runId}-${index}`,
    payload,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
  };
}

/** Deterministic pseudo-random owner history covering resumes and id-less work. */
function randomHistory(runId, count, seed) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const types = [
    "provider_session_activity",
    "provider_host_work_started",
    "provider_host_work_settled",
    "provider_work_inventory",
  ];
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const eventType = types[Math.floor(next() * types.length)];
    const owner = next() < 0.8 ? OWNER : OTHER;
    const roll = next();
    const workId =
      roll < 0.05 ? undefined : roll < 0.08 ? "" : `tool:${Math.floor(next() * 12)}`;
    events.push(makeEvent(runId, index, eventType, owner, workId));
  }
  return events;
}

function ownerOnly(events, owner) {
  return events.filter(
    (event) =>
      event.payload.ownerSessionId === owner.ownerSessionId &&
      event.payload.providerSessionKey === owner.providerSessionKey,
  );
}

function lastActivityId(events) {
  return events.filter((event) => event.eventType === "provider_session_activity").at(-1)?.id;
}

test("compact owner evidence decides open work exactly like the full history", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const history = randomHistory("run-eq", 300, seed);
    const full = ownerOnly(history, OWNER);
    const compact = compactOwnerWorkEvents(history, OWNER);
    assert.deepEqual(
      new Set(findPendingWorkEntries(compact).map(([id]) => id)),
      new Set(findPendingWorkEntries(full).map(([id]) => id)),
      `seed ${seed}`,
    );
    assert.equal(lastActivityId(compact), lastActivityId(full), `seed ${seed}`);
    assert.ok(compact.every((event) => event.payload.ownerSessionId === OWNER.ownerSessionId));
  }
});

for (const kind of ["json", "sqlite"]) {
  test(`${kind} store owner work evidence matches the compact reduction`, () => {
    const store = createStore(kind);
    const runId = createRoute(store, kind);
    const history = randomHistory(runId, 400, 7);
    for (const event of history) store.recordEvent(event);
    const expected = compactOwnerWorkEvents(
      store.getEventSnapshot(runId, 100_000).events,
      OWNER,
    );
    assert.ok(expected.length > 0);
    assert.deepEqual(
      store.getOwnerWorkEvidence(runId, OWNER).map((event) => event.id),
      expected.map((event) => event.id),
    );
    assert.deepEqual(store.getOwnerWorkEvidence("missing-run", OWNER), []);
    store.close?.();
  });
}

test("a route longer than the snapshot cap still proves its work settled", () => {
  const store = createStore("sqlite");
  const runId = createRoute(store, "sqlite");
  let index = 0;
  store.recordEvent(makeEvent(runId, index++, "provider_session_activity", OWNER));
  // 10,100 settled tool calls plus noise push the history past the old cap.
  for (let call = 0; call < 5050; call += 1) {
    store.recordEvent(makeEvent(runId, index++, "provider_host_work_started", OWNER, `tool:${call}`));
    store.recordEvent(makeEvent(runId, index++, "provider_host_work_settled", OWNER, `tool:${call}`));
  }
  const snapshot = store.getEventSnapshot(runId, 10_000);
  assert.ok(snapshot.totalCount > snapshot.events.length, "old snapshot is truncated");

  const settled = readOwnerWorkEvidence(store, runId, OWNER);
  assert.ok(Array.isArray(settled), "evidence stays complete past the cap");
  assert.equal(findPendingWorkEntries(settled).length, 0);

  store.recordEvent(makeEvent(runId, index++, "provider_host_work_started", OWNER, "subagent:open"));
  const open = readOwnerWorkEvidence(store, runId, OWNER);
  assert.deepEqual(
    findPendingWorkEntries(open).map(([id]) => id),
    ["subagent:open"],
  );
  store.close?.();
});

test("a store without the evidence query fails closed on a truncated snapshot", () => {
  const legacy = {
    getEventSnapshot: () => ({ events: [], totalCount: 1 }),
  };
  assert.equal(readOwnerWorkEvidence(legacy, "run", OWNER), null);
  const complete = {
    getEventSnapshot: () => ({
      events: [makeEvent("run", 0, "provider_host_work_started", OWNER, "tool:a")],
      totalCount: 1,
    }),
  };
  assert.deepEqual(
    findPendingWorkEntries(readOwnerWorkEvidence(complete, "run", OWNER)).map(([id]) => id),
    ["tool:a"],
  );
});
