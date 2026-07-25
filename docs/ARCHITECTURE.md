# Architecture

Overtli Task Manager is built around a shared core library used by both MCP tools and Codex hooks.

```text
Codex MCP tools ─┐
                 ├─ OTM core state machine ── durable store
Codex hooks    ──┘                          ├─ session current.json/current.md
                                            └─ workspace current index
```

## State

The durable store tracks runs, tasks, events, summaries, and cache entries.
SQLite is preferred; `auto` can use JSON whenever the native runtime is
unavailable, while explicit `sqlite` remains fail-closed.

Active routes are selected by `(normalized workspaceRoot, sessionId)`. The
session id resolves from explicit session/thread/conversation hook fields,
`OTM_SESSION_ID`, or `CODEX_THREAD_ID`, in that order. A supplied `runId` is
still validated against the current workspace and session. This makes separate
chats and VS Code windows independent even when they share one repository and
global store. Legacy active rows with no session id remain isolated unless
`OTM_CLAIM_LEGACY_ROUTE=1` explicitly enables one-time adoption. SQLite uses WAL
mode and a composite workspace/session/status index; the JSON fallback
serializes mutations through a short-lived cross-process lock file.

SQLite availability is verified by constructing and querying an in-memory
database because `better-sqlite3` loads its ABI-specific native binding lazily.
On a detected Node ABI mismatch, normal store initialization makes one bounded
automatic rebuild attempt with the active Node installation. A package-local
lock prevents competing hooks and MCP processes from rebuilding the same addon
concurrently; stale locks are reclaimed only after their owner is no longer
live. `OTM_AUTO_REBUILD_SQLITE=0` disables this repair, and CI suppresses it
unless explicitly enabled. If repair remains unavailable, `OTM_STORAGE=auto`
uses JSON while leaving existing SQLite state untouched; doctor reports both the
fallback and inactive SQLite path. Explicit `OTM_STORAGE=sqlite` remains
fail-closed with Node version, module ABI, and rebuild guidance.

SQLite state carries a schema version independently from the package version.
Opening an older schema runs ordered transactional migrations after a local
pre-migration backup is made. JSON state is validated as a complete document;
invalid or orphaned records are quarantined with recovery guidance rather than
being silently replaced. Route creation is one store operation covering the
run, all initial tasks, and its first event, so competing starts cannot create
two active routes for one canonical workspace/session scope.

All evidence and hook command capture pass through credential redaction before
they enter durable state or scratch files. `OTM_COMMAND_CAPTURE` selects
`redacted` (the default), `none`, or `validation-only` command retention. This
protects common secret forms,
but OTM is not a credential store and users must not intentionally supply
secrets as route input.

Installed session hooks create or refresh only OTM's marker-delimited root
`AGENTS.md` block by default. `UserPromptSubmit` repeats the repair so a
workspace opened before the hook was installed still receives current guidance
on its first substantive prompt. Existing content outside the markers is
preserved; malformed marker pairs are reported without being overwritten. Set
`OTM_AUTO_SYNC_AGENTS=0` to opt out.

For substantive new prompts, `UserPromptSubmit` creates a conservative durable
bootstrap route unless `OTM_AUTO_START_ROUTE=0`. That fallback contains one
visible `needsModelReview` scaffold and is deliberately non-completable. The
hook instructs the model to review the complete request and reconcile a
domain-specific route before implementation. For an active route, later typed,
structured, attachment/OCR, and visual context is appended first; the
contract-review gate remains pending until the model reconciles the hierarchy.

`src/core/source-context.mjs` normalizes those input surfaces into bounded,
redacted entries with source kind, structural path, optional source reference,
revision, byte count, and a deterministic accumulated digest. The complete
record is stored in run metadata and canonical session snapshots. It survives
JSON/SQLite persistence, restart, hierarchy-aware summaries, history, and
export/import. The workspace `current.json` index intentionally retains only
lightweight route pointers and never copies the source contract.

The model supplies three structural tiers:

1. A task is one stop-gated route segment for a major outcome, such as Phase 3.
   It carries a model-interpreted `workType`. Recommended labels are
   `planning`, `review`, `research`, `documentation`, `implementation`,
   `validation`, `release`, `deployment`, `operations`, and `mixed`; bounded
   custom labels remain valid when the model records a clearer domain intent.
2. Its `internalSteps` are substantive explicit children such as Phase
   3.1/3.2, or the minimum outcome-specific subtasks inferred by the model when
   no children are stated.
3. Each non-atomic internal subtask owns concrete `miniSteps`. A genuinely
   atomic subtask must include an explicit rationale.

Explicit identifiers, wording, and order remain authoritative. Provenance marks
inferred structure without pretending it came from the user. OTM validates
structure, dependencies, evidence, and state transitions but does not generate
canned domain work. Reconciliation matches outlines, stable IDs, and titles to
preserve valid evidence and timestamps; new required descendants reopen a
previously completed parent. A task cannot move to `done` while contract review
is pending, a fallback scaffold remains, a required dependency/mini-step/
internal subtask is non-terminal, required descendant evidence is absent, or
gate evidence is missing.

`routeIntent` is derived from the active gates and persisted in run metadata,
snapshots, and summaries. It is `mixed` whenever gate labels differ or a gate
is intrinsically mixed. This aggregation is descriptive rather than coercive:
planning/review/documentation gates keep outcome-appropriate evidence contracts
and do not imply unrequested code changes, while implementation gates retain
implementation, integration, validation, and affected-documentation evidence.

The OTM route is deliberately separate from a host-native Codex goal: MCP
servers and hooks cannot invoke Codex's private goal-control API. They inject
guidance for the agent to create one native goal when available, keep it active
through every OTM gate, and terminally update it only after the stop audit. A
pause leaves the canonical hierarchy durable; session/continuation hooks reload
its exact descendant checkpoint.

The core owns explicit transition matrices rather than trusting a requested
status. Task edges are `pending -> active|dropped|superseded`, `active ->
pending|done|blocked|dropped|superseded`, `blocked -> active|pending|dropped|
superseded`, and a recorded reopen is required for terminal tasks to return to
`active` or `pending`. Run edges similarly constrain finalization, clear,
abandon, resume, and archive. Every public task mutation validates the scoped
run/task identity, expected revision, and the applicable matrix edge before
the store's atomic mutation is committed.

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
cutoff. Cleanup and history dry-run modes are read-only previews: they do not
create a missing store, rewrite JSON state, rotate a recovery backup, or remove
candidate scratch files.

`otm doctor` is also read-only. It opens SQLite with a read-only connection and
parses JSON directly so malformed state remains available for recovery. It
reports integrity/schema status, duplicate active scopes, orphan records,
unknown statuses, locks, current-file/index divergence, and hooks JSON health.
`otm doctor --repair` is an explicit summary-file republish action and refuses
to run when the diagnostic report includes integrity errors.

## Project memory

Project memory is not a full RAG index. It is a lightweight, project-specific cache that prefers overview files and durable summaries. Search normalizes tokens and returns a numeric score plus `matchReasons`: exact phrase matches receive a 5-point boost, title-token matches 3 points each, tag-token matches 2 each, body-token matches 1 each, recent updates receive a small documented boost, and an explicit `scoreHint` is additive. Expired entries are excluded from normal search/listing.

Finalization writes turn-summary memory with a stable identifier derived from the
durable run and summary IDs. Retrying the same operation updates that one
memory record; separate runs with identical human-readable goals retain their
own summary memory. Summary JSON preserves the bounded source contract,
contract-review state, and complete gate/subtask/mini-step hierarchy; searchable
summary Markdown/cache records expose a concise source digest and revision count
instead of duplicating the full contract into many cache entries.

## Hooks

Hooks require a resolved Codex session before reading or mutating route state.
Global and workspace installs may both be active, so a short-lived atomic claim
deduplicates each host invocation across processes. The first invocation owns
the output; duplicates return silently.

The Stop hook is the enforcement and default finalization gate. If required
route segments remain open, the first invocation returns one block decision and
Codex continues the turn with the remaining work. Once the audit passes, the
hook automatically finalizes the route, persists the summary and checkpoint
memory, clears active state, and blocks once with the saved summary so Codex can
send the final user-facing reply. A host-marked continuation
(`stop_hook_active`) is released to bound the loop. Set
`OTM_STOP_AUTO_FINALIZE=0` for the explicit audit, finalize, present, and clear
workflow. Missing session identity is never mapped to a legacy route, and
Stop-hook failures fail open with a warning.

An unfinished route is never cleared through the normal completion action.
Clients must use the explicit abandon operation with a recorded reason
(`otm_abandon` or `otm abandon --run-id ... --reason ... --confirm`); normal
clear remains finalization-gated.
