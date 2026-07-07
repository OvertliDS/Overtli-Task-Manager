# Architecture

Overtli Task Manager is built around a shared core library used by both MCP tools and Codex hooks.

```text
Codex MCP tools ─┐
                 ├─ OTM core state machine ── durable store
Codex hooks    ──┘                          ├─ session current.json/current.md
                                            └─ workspace current index
```

## State

The durable store tracks runs, tasks, events, summaries, and cache entries. SQLite is preferred; JSON is a fallback for machines that cannot install native dependencies.

Active routes are selected by `(normalized workspaceRoot, sessionId)`. The
session id resolves from explicit session/thread/conversation hook fields,
`OTM_SESSION_ID`, or `CODEX_THREAD_ID`, in that order. A supplied `runId` is
still validated against the current workspace and session. This makes separate
chats and VS Code windows independent even when they share one repository and
global store. Legacy active rows with no session id remain isolated unless
`OTM_CLAIM_LEGACY_ROUTE=1` explicitly enables one-time adoption. SQLite uses WAL
mode and a composite workspace/session/status index; the JSON fallback
serializes mutations through a short-lived cross-process lock file.

Tasks are the stop-gated route checkpoints. Each task may also carry
`metadata.internalSteps`, which are normalized from model-supplied strings or
objects into durable `{ id, title, status }` records. These records preserve the
AI's exact internal progress location through `current.json`, compaction, and
handoff. Internal-step statuses are intentionally separate from the task status:
checking off a substep does not complete the route gate. A task cannot move to
`done` until every internal step is terminal (`done` or `skipped`) and the
completion call includes concrete evidence. This keeps compaction-resume detail
and stop-gated route completion aligned without letting either replace the
other.

## Workspace files

Workspace state is intentionally small and inspectable:

```text
.codex/overtli-task-manager/current.json
.codex/overtli-task-manager/current.md
.codex/overtli-task-manager/sessions/<session-key>/current.json
.codex/overtli-task-manager/sessions/<session-key>/current.md
.codex/overtli-task-manager/sessions/<session-key>/cache/scratch/
.codex/overtli-task-manager/summaries/
.codex/overtli-task-manager/cache/
.codex/overtli-task-manager/cache/tmp/
.codex/overtli-task-manager/cache/scratch/
```

Atomic writes for current route files, install manifests, and summaries stage
temporary files under `cache/tmp/`. Current-state writes also remove stale
OTM-owned `current.json.*.tmp` and `current.md.*.tmp` artifacts left by older
versions or interrupted writes, while leaving unrelated files untouched.
Long raw hook/tool payloads that would make route Markdown noisy are stored in
`cache/scratch/` and referenced from evidence with a short path. Scoped
workflow cleanup removes only that session's expired scratch dumps; unscoped
maintenance does not prune scoped scratch while scoped routes remain active.
Atomic temp cleanup uses a shorter concurrency guard so active writes are not
deleted.
The top-level current files are a workspace-wide index when session scoping is
active. Canonical route state lives under the hashed session key returned in
each snapshot's `paths`; raw session ids are not exposed by the index. Clearing
one route updates its canonical files and index entry while leaving other
sessions and their scratch evidence intact. Index rebuilds use a short-lived
workspace lock so separate OTM processes cannot publish a lost-update view.
At route completion, `otm_clear_current` runs immediate OTM-owned temp/scratch
cleanup. `otm_cleanup_workspace` and `otm cleanup` expose the same cleanup path
for explicit maintenance.

Durable store cleanup is retention-based and separate from workspace file
cleanup. The default retention window is 7 days. `otm_clear_current` invokes a
best-effort history prune after clearing the active route, and
`otm_prune_history` / `otm prune-history` expose the same database cleanup
explicitly. The prune preserves active, blocked, and paused runs, then removes
inactive runs older than the cutoff along with their tasks, events, and
summaries. Cache entries are pruned when they are expired or older than the
cutoff. Dry-run mode reports the row counts without deleting anything.

## Project memory

Project memory is not a full RAG index. It is a lightweight, project-specific cache that prefers overview files and durable summaries.

## Hooks

Hooks require a resolved Codex session before reading or mutating route state.
Global and workspace installs may both be active, so a short-lived atomic claim
deduplicates each host invocation across processes. The first invocation owns
the output; duplicates return silently.

The Stop hook is the enforcement gate. If required route segments remain open,
the first invocation returns one block decision and Codex continues the turn
with the remaining work. A host-marked continuation (`stop_hook_active`) is
released to bound the loop, missing session identity is never mapped to a legacy
route, and Stop-hook failures fail open with a warning. Normal closeout remains
explicit: audit, finalize, present the summary, then clear. Clear recovers the
just-finalized session run from its canonical snapshot so durable run and
summary state are marked cleared even when finalize and clear are separate
calls.
