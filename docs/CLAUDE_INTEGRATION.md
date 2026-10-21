# Claude Code integration contract

Status: provider-neutral shared continuation, Claude stdio tools, all eleven
official Claude command-hook event handlers, and the user-settings installer
are implemented in source. The installer has focused merge/idempotency/hash-
checked rollback coverage. Local workstation activation on 2026-10-20 aligned
the user hooks and registered 12-tool frontend with the existing canonical
Codex SQLite store. An actual official initialization invoked the installed
startup hook without a model prompt. The frontend read the existing Codex run
and rejected legacy-owner continuation without changing its binding/revision.
Eligible transfers remain qualified by isolated JSON/SQLite tests; manual
compaction was not forced. New installations still require the explicit setup
and exact-store alignment described below.

## Session and storage boundary

The existing reusable core is `createTaskManager` in
[`src/core/manager.mjs`](../src/core/manager.mjs). It already implements route
start/reconciliation, recursive progress and evidence, gate completion, Stop
audit, finalization and summary persistence, pause/resume, snapshots, and
workspace project-memory search. Codex identity resolution in
[`src/core/session-scope.mjs`](../src/core/session-scope.mjs) remains unchanged.

Use [`src/core/provider-session.mjs`](../src/core/provider-session.mjs) and
[`src/core/provider-adapter.mjs`](../src/core/provider-adapter.mjs) as the
stable next-stage boundary. The host must derive `provider` and
`nativeSessionId` from its trusted, authenticated request/session context. Do
not accept either as a user-controlled tool argument and do not infer provider
identity from a model name.

```js
import { createProviderAdapter } from "../src/core/provider-adapter.mjs";

const otm = createProviderAdapter({
  provider: "claude",
  nativeSessionId: trustedClaudeSessionId,
  workspaceRoot: trustedWorkspaceRoot,
  env: process.env,
  store: sharedOtmStore,
});
```

`createProviderSession({ provider, nativeSessionId })` returns
`{ provider, sessionId, providerSessionKey }`. Codex keeps its historical raw
session id so existing bindings remain readable. Claude gets the deterministic
opaque id `otm-provider:claude:v1:<sha256>`. The raw Claude id is not persisted
by these helpers. `createProviderEnvironment(env)` returns a copy with
`OTM_SESSION_ID` and `CODEX_THREAD_ID` removed, preventing inherited Codex
identity from selecting or conflicting with a Claude route. It does not mutate
the supplied environment.

The adapter fixes provider and session identity for its lifetime. Each operation
receives `sessionId` from that closure; caller-supplied session aliases are
removed after they are checked against that same native or mapped identity.
Conflicting identities raise `PROVIDER_SESSION_MISMATCH`. A provider override
raises `PROVIDER_IDENTITY_CONFLICT`, and cross-provider subagent or usage
attribution raises `CROSS_PROVIDER_OPERATION_FORBIDDEN`.

Pass the existing shared OTM store when integrating into a host that already
owns one. This keeps one durable store for both providers while the mapped
session id keeps route bindings separate. Without `store`, the adapter creates
its own store from `env`; call `close()` only for that adapter-owned store. Do
not create or close an adapter for every individual tool call. A host may keep
one adapter per trusted provider session or create request-scoped adapters that
share its store.

## Claude-only bounded phase evidence batching (2026-10-21)

A production Opus/Haiku smoke verified correct worker routing but identified six separate root model-tool turns for three gate progress/complete pairs. The Claude MCP frontend now exposes a thirteenth tool, **`otm_phase`**. Codex's original tools and routing are unchanged.

One signed `sessionCapability` protects the entire ordered batch (maximum 16 operations), which may contain only `otm_start_task`, `otm_progress`, `otm_complete_task` and `otm_audit_stop`. Entire nested schemas, user session identity and workspace scope are verified **before** any transition. Every applied operation goes through the existing canonical OTM adapter and retains decomposition review, pending-to-active, evidence, ownership, Stop and descendant gates.

Example of the allowed shape (IDs and evidence must come from the actual current route):

```json
{
  "sessionCapability": "<short-lived capability from the Claude OTM hook>",
  "operations": [
    {"name":"otm_start_task","arguments":{"taskId":"task_alpha"}},
    {"name":"otm_progress","arguments":{"taskId":"task_alpha","internalStepIndex":0,"internalStepStatus":"done","message":"Focused check passed"}},
    {"name":"otm_complete_task","arguments":{"taskId":"task_alpha","evidence":{"kind":"test_result","summary":"Verified focused check"}}}
  ]
}
```

**Live Opus/Haiku qualification lesson:** `otm_complete_task` does **not** accept a `summary` or `status` argument. It accepts the exact active `taskId` and, when required, `evidence`. Model-reviewed internal-step evidence must be recorded first with `otm_progress` (`internalStepId`/status/evidence) before closing the parent gate. The Claude frontend now reports the exact invalid operation index and unsupported keys at prevalidation, with a targeted completion hint; no partial OTM state is written for unsupported fields.

The operation is **sequential and fail-fast, not globally atomic**. If a later valid operation fails, it returns `ok:false`, the exact applied indices, the failure code and a requirement to inspect `otm_snapshot` before any retry. Earlier accepted state is preserved, never silently rolled back or replayed. Invalid nested arguments/actions are rejected up front and apply nothing. Do not use this interface for structural reconciliation, cross-provider continuation or untrusted task-ownership changes.

This tool is intended for **post-worker accepted phases**. Use one structural `otm_reconcile` to review/decompose the original request, then native Claude Agents do the work and `otm_phase` settles several independently verified gates. It reduces redundant root tool turns; it does not eliminate the required final Stop audit or permit fabricated evidence.

## Adapter API

`createProviderAdapter` returns API version
`otm.provider-adapter.v1`, a read-only `provider` and `session` description,
and these methods. Each method uses the existing manager's result shape and
accepts the existing OTM arguments except provider/session identity is bound
by the adapter.

| Adapter method                  | Existing core method                                   | Purpose                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTask(args)`               | `manager.start(args)`                                  | Start or reuse the canonical route.                                                                                                                   |
| `reconcileTask(args)`           | `manager.reconcile(args)`                              | Re-review the accumulated source contract and revise gates.                                                                                           |
| `markTaskActive(args)`          | `manager.markTaskActive(args)`                         | Begin one exact route gate.                                                                                                                           |
| `recordProgress(args)`          | `manager.progress(args)`                               | Record progress or descendant updates.                                                                                                                |
| `recordEvidence(args)`          | `manager.progress(args)`                               | Record gate/descendant evidence; requires `evidence`.                                                                                                 |
| `completeTask(args)`            | `manager.completeTask(args)`                           | Complete one gate after normal review and evidence checks.                                                                                            |
| `blockTask(args)`               | `manager.blockTask(args)`                              | Record a blocker through the existing task state machine.                                                                                             |
| `auditStop(args)`               | `manager.auditStop(args)`                              | Return the final route audit; adapter sets `write:false`.                                                                                             |
| `inspectOwnedWork(args)`        | Trusted host inspector + complete owner event snapshot | Prove the exact current route owner has no active or unknown native-broker/ODC work; this lifecycle helper does not apply the transfer idle interval. |
| `finalizeTurn(args)`            | `manager.finalizeTurn(args)`                           | Persist the durable turn summary after audit. `clearCurrent:true` clears the finalized current route.                                                 |
| `checkpoint(args)`              | `manager.snapshot` + `manager.upsertMemory`            | Save a provider-attributed checkpoint without finalizing the route.                                                                                   |
| `resumeRun(args)`               | `manager.resumeRun(args)`                              | Resume an unfinished blocked or paused route.                                                                                                         |
| `snapshot(args)`                | `manager.snapshot(args)`                               | Load the exact session's current or requested route.                                                                                                  |
| `searchProjectMemory(args)`     | `manager.searchMemory(args)`                           | Search the workspace's project memory.                                                                                                                |
| `recordSubagentOwnership(args)` | `manager.recordEvent(...)`                             | Persist same-provider worker/task attribution; does not dispatch or lease work.                                                                       |
| `recordUsageAttribution(args)`  | `manager.recordEvent(...)`                             | Persist observed usage and outcome attribution; does not read provider meters.                                                                        |

Use the existing task and evidence schemas in
[`src/mcp/schemas.mjs`](../src/mcp/schemas.mjs) and the authoritative core tool
descriptions in [`src/mcp/tools.mjs`](../src/mcp/tools.mjs). The Claude stdio
frontend's model-facing tool names and adapter mapping are:

| Claude-facing OTM action | Adapter call             | Argument contract                                                                                                                                           |
| ------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otm_start`              | `startTask`              | `goal`, optional bounded source context and model-authored `tasks`; Claude workspace comes from the signed capability.                                      |
| `otm_reconcile`          | `reconcileTask`          | Exact `runId`, mode, source context, and `changes` or reviewed `tasks`.                                                                                     |
| `otm_snapshot`           | `snapshot` / shared read | Optional exact `runId`; otherwise reads this Claude session's current route.                                                                                |
| `otm_start_task`         | `markTaskActive`         | Required exact `taskId`, optional `runId` and `note`.                                                                                                       |
| `otm_progress`           | `recordProgress`         | Existing gate evidence and nested internal/mini-step fields or ordered updates.                                                                             |
| `otm_complete_task`      | `completeTask`           | Required exact `taskId`, optional `runId` and accepted evidence.                                                                                            |
| `otm_block_task`         | `blockTask`              | Required exact gate and actionable blocker reason.                                                                                                          |
| `otm_audit_stop`         | `auditStop`              | Optional exact `runId`; forces `write:false` and does not finalize.                                                                                         |
| `otm_resume`             | `resumeRun`              | Exact blocked/paused unfinished `runId`, optional task and reason.                                                                                          |
| `otm_checkpoint`         | `checkpoint`             | Exact `runId` and optional `checkpointKey`; records shared continuation state without finalizing.                                                           |
| `otm_history`            | `readSharedHistory`      | Compact cross-workspace history; `scope`, `offset`, `limit`, exact `runId`/`summaryId`, and bounded `maxChars` summary chunks. Reads never claim ownership. |
| `otm_continue`           | `continueTask`           | Exact `runId` and required `expectedRevision`; transfers only after full host evidence and recency checks.                                                  |

Do not expose `sessionId`, `session_id`, `threadId`, `thread_id`,
`conversationId`, `conversation_id`, or `provider` in the user-facing Claude
tool schemas. The host supplies trusted identity out of band. Keep OTM's
existing JSON schemas and recursive validation as the source of truth; do not
weaken evidence or completion gates for a Claude-specific tool wrapper.

## Attribution schemas

`recordSubagentOwnership` takes:

```json
{
  "runId": "<exact current run id>",
  "taskId": "<exact top-level route task id>",
  "workerNativeSessionId": "<trusted Claude Agent session id>",
  "workerProvider": "claude",
  "operationId": "<optional idempotency input>"
}
```

The persisted event contains provider-scoped hashes for the owner and worker,
the route/task ids, and the fixed provider. It never stores
`workerNativeSessionId`. The event is attribution only: the Claude-native Agent
API owns dispatch, cancellation, concurrency, and worker lifecycle. It is not
a lock and does not prove a worker actually started or completed work. The
caller must record real result evidence through `recordEvidence` or
`recordProgress` before completing a gate.

`recordUsageAttribution` takes an exact `runId` and optional `taskId`, then
accepts these optional observed fields:

```json
{
  "runId": "<exact current run id>",
  "taskId": "<optional exact route task id>",
  "workerNativeSessionId": "<optional trusted same-provider Agent id>",
  "workerProvider": "claude",
  "role": "root",
  "modelId": "<observed model id>",
  "effort": "<observed effort>",
  "startedAt": "<ISO timestamp>",
  "endedAt": "<ISO timestamp>",
  "durationMs": 1234,
  "inputTokens": 123,
  "outputTokens": 45,
  "toolInvocationCount": 4,
  "retryCount": 0,
  "contextCompactions": 0,
  "outcome": "completed",
  "apiEquivalentCostUsdEstimate": 0.01,
  "usageEvidenceRef": "<reference to a supported observation>",
  "usage": { "cacheReadInputTokens": 20, "subscriptionPercent": null },
  "operationId": "<optional idempotency input>"
}
```

Counts must be non-negative safe integers; estimates must be finite and
non-negative. Missing/unknown values stay `null`. Labels are bounded and passed
through OTM credential redaction. The API-equivalent price field is explicitly
an estimate and never represents a Claude subscription charge. This API does
not scrape Claude usage, inspect credentials, call a model, or calibrate
subscription meters.

`checkpoint({ runId, checkpointKey? })` writes a concise `provider_checkpoint`
memory entry in the route's primary workspace. It is a continuation pointer,
not a completion summary. `searchProjectMemory({ query, workspaceRoot?, limit? })`
uses OTM's existing workspace-level cache; project memory is shared workspace
context and may contain entries created by either provider. `resumeRun` only
transitions an unfinished `blocked` or `paused` route back to active. For a
normal active continuation, load `snapshot()` and continue from its exact task
ids; terminal routes require ordinary reconciliation rules.

`auditStop({ runId })` sets `write:false` to avoid rewriting current snapshot
files. The existing core can still update its canonical binding's
`lastResolution` audit metadata. Call `finalizeTurn` only after a passing audit
unless a human explicitly authorizes incomplete finalization with its required
reason. The Claude hook runner audits before finalizing and clearing; no MCP
tool can bypass the normal OTM gate checks.

## Official Claude Code hook contract

This section is aligned to Anthropic's [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks), checked on 2026-10-20. Command hooks receive a JSON object on stdin. Common identity fields are `session_id` and `hook_event_name`; other common fields may include `cwd`, `transcript_path`, `permission_mode`, `effort`, `agent_id`, and `agent_type`. The transcript is written asynchronously and may lag the event. Use documented event fields such as `last_assistant_message` rather than reading the transcript for the just-finished response.

`mapClaudeHookPayload(payload)` in `src/core/provider-session.mjs` is the OTM identity mapping contract. It accepts the lifecycle events listed below, binds the provider to `claude`, maps `session_id` to `nativeSessionId`, and returns the corresponding opaque OTM `session`. For `SubagentStart` and `SubagentStop`, it requires the official `agent_id` and returns it as `workerNativeSessionId` for an immediate call to `recordSubagentOwnership`. In hook payloads the documented key is `agent_id`, not `subagent_id`. This helper validates payload shape; it does not authenticate its caller. Call it only inside the trusted Claude Code hook/request boundary, and never offer it as a user-callable tool.

| Claude event         | Official payload fields used by this contract                                                                                        | Implemented OTM behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`       | `source`: `startup`, `resume`, `clear`, `compact`, or `fork`; optional `model`, `agent_type`, `session_title`                        | Inject a fresh signed session capability and load this session's exact canonical route. If unbound, show shared active-route history and the explicit `/otm continue <runId>` instruction. A fork has a new session identity and does not inherit ownership implicitly.                                                                                                                                                                                                                                                             |
| `UserPromptSubmit`   | `prompt`                                                                                                                             | Refresh the short-lived capability. Start or reconcile the shared route for substantive work; exact `/otm continue <runId>` is the explicit cross-provider transfer request and still requires safe-work evidence.                                                                                                                                                                                                                                                                                                                  |
| `PreToolUse`         | `tool_name`, `tool_input`, `tool_use_id`; MCP calls may include `mcp_server`                                                         | Record host activity and a pending tool-use receipt keyed to official `tool_use_id`. Tool arguments are not treated as job-settlement evidence.                                                                                                                                                                                                                                                                                                                                                                                     |
| `PostToolUse`        | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`; optional `duration_ms`; MCP calls may include `mcp_server`                | Settle the matching host tool-use receipt. The optional trusted evidence observer receives the raw official payload; only its verified exact `tool_response.jobId` may join a durable job record. The observer never derives a job id from `tool_input`.                                                                                                                                                                                                                                                                            |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `error`; optional `is_interrupt`, `duration_ms`; MCP calls may include `mcp_server`        | Settle the matching tool-use receipt as failed. It does not claim work completed.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SubagentStart`      | `agent_id`, `agent_type`                                                                                                             | Record the official child id as an active host-work receipt. This is observation only, not agent dispatch or a completion receipt.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SubagentStop`       | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` | Settle only the exact previously observed `agent_id`. No cross-provider messages, dispatch, or automatic handoff is performed.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Stop`               | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`                                                    | The loop guard returns before fallible observer/store work when `stop_hook_active` is true. Otherwise absent/unknown/nonterminal Claude inventory, missing/incomplete owner coverage, active ODC intent/job, unproven native-broker/ODC inspection, truncated OTM event history, or unmatched PreToolUse/SubagentStart receipts blocks. With complete terminal owner-work and OTM receipt inventories, OTM runs `auditStop`; only a passing audit finalizes and clears the route. A stopped chat alone never settles detached jobs. |
| `PreCompact`         | `trigger` (`manual` or `auto`), `custom_instructions`                                                                                | Save an idempotent canonical OTM checkpoint for the exact route revision before compaction. Do not store compaction instructions. Although Claude permits PreCompact blocking, OTM never blocks or changes host-work ownership here.                                                                                                                                                                                                                                                                                                |
| `PostCompact`        | `trigger`, `compact_summary`                                                                                                         | Read canonical route state internally but do not convert or persist the native Claude summary. Claude discards PostCompact `systemMessage` and `continue`; `SessionStart` with `source=compact` injects route context and refreshes the capability.                                                                                                                                                                                                                                                                                 |
| `SessionEnd`         | `reason`: `clear`, `resume`, `logout`, `prompt_input_exit`, or `other`                                                               | Record best-effort activity/end state only. SessionEnd cannot decide completion and is never used as proof that native children, detached jobs, or task-owned claims settled.                                                                                                                                                                                                                                                                                                                                                       |

Compaction uses provider-specific lifecycle events over one canonical OTM
checkpoint and route. Native Claude and Codex transcript summaries stay with
their respective hosts. Claude reloads the canonical route and refreshes its
capability through `SessionStart(source=compact)`; Codex injects the route
through `SessionStart(source=compact)`'s `hookSpecificOutput.additionalContext`
before the next model request. Codex `PreCompact` and `PostCompact` receive
`trigger` and `turn_id`; Codex supports `continue: false` to stop before or
after compaction, but OTM does not return it. Its `systemMessage` is a warning
channel, so OTM does not emit the route summary there. Both providers' compact
hooks leave unfinished workers, detached jobs, task-owned resource claims, and route
ownership untouched. Only verified terminal work evidence can settle those resources or
make a route eligible for an explicit ownership transfer. See the official
[Codex hooks reference](https://learn.chatgpt.com/docs/hooks) for the compact
event and `SessionStart(source=compact)` output contracts. The packaged Codex
SessionStart matcher covers `startup`, `resume`, `clear`, and `compact`;
`startup` alone may establish a new trusted owner-coverage epoch. Resume, clear,
and compact restore shared OTM route context without resetting existing host
work evidence or claiming that any worker has settled.

The same `agent_id` and `agent_type` fields can appear on tool events invoked inside a subagent. They can correlate a tool call to a previously registered worker and are distinct from the main `session_id`. OTM does not read or import native transcript files, dispatch/cancel Claude-native agents, or transfer them between providers. Official start/stop events are only one signal; the trusted host inspector must also confirm the actual native broker and ODC job stores before a run is eligible for transfer. Task-owned resource claims recorded in the native broker remain part of that owner-work proof; unrelated global GPU availability is not a continuation gate.

When a subagent uses `SubagentHandback` (Claude Code v2.1.271+), its report arrives in the handback tool's `tool_input.message`; `SubagentStop.last_assistant_message` may contain only its closing text. Capture the delivered report from the matching tool event and keep the normal review/evidence gate before accepting it.

### Hook decisions and host behavior

The reference distinguishes decisions from observation. Exit code `0` with no output means no decision. For a structured decision, emit one JSON object on stdout and exit `0`. `Stop` and `SubagentStop` use top-level `{"decision":"block","reason":"..."}` to continue work; Claude also permits that decision from `PreCompact`, but OTM never blocks compaction. `PreToolUse` uses `hookSpecificOutput.permissionDecision` rather than the top-level decision. Exit code `2` blocks where an event supports blocking, including `PreToolUse`, `Stop`, `SubagentStop`, and `PreCompact`, but its meaning is event-specific. `PostCompact` has no decision control and discards `systemMessage` and `continue`. `PostToolUse` and `PostToolUseFailure` run after the tool's effect; exit code `2` cannot undo the result. For these OTM hooks prefer exit `0` plus the documented structured output instead of relying on an event's error-code behavior.

Hook timeouts cancel the command and discard its output. On most events that means no decision; a timed-out `PreToolUse` does not block unless the hook's failure policy says to block. In the official reference, `onFailure: "block"` is available for command/HTTP hooks from Claude Code v2.1.295; it does not make failed `Stop`, `SubagentStop`, `TaskCompleted`, or `TeammateIdle` hooks block-safe. `SessionEnd` has no decision control and defaults to a 1.5-second timeout. Hooks should use explicit bounded timeouts and must not make route correctness depend on a best-effort SessionEnd callback.

On Windows without Git Bash, the installer uses exec-form Node hooks with an
explicit executable and argument array; it does not depend on shell selection.
The complete set is installed only at Claude's supported user settings path,
`~/.claude/settings.json`; an installation remains inactive until its operator
applies it and loads the changed settings in Claude.
`npm run install:claude-hooks -- --dry-run` prints the proposed hash without
writing. An applied install saves and verifies a same-directory backup, stages
and hash-checks the merged file, rechecks the original hash immediately before
atomic replacement, and prints the exact rollback receipt. Repeating an
unchanged install is a no-op. Rollback requires the recorded backup hash and
the current installed hash; a changed settings file stops rollback.

Source tests exercise mocked official payloads and an isolated user-settings
fixture. They verify the hook contract and rollback behavior, but do not
establish live Claude Code behavior. The local official startup and registered
MCP qualification above is separate evidence; it does not turn every mocked
lifecycle test into a live event test. `Stop` is
skipped on user interrupt, and API errors use `StopFailure`; neither path
proves a passing audit.

## Shared routes, tools, and continuation

`src/claude/mcp-server.mjs` is an additive Claude stdio frontend over the same
`createStore()` and core manager as Codex. It does not import or edit the shared
Codex MCP server. Register the `otm-claude-mcp` executable in Claude's user
MCP scope and configure the same `OTM_STORAGE` backend, `OTM_STATE_DIR`, and
trusted host-evidence module used by Codex. If these values point to a different
state directory/backend, Claude will see a different database and history.
Claude's standard local stdio registration accepts the form
`claude mcp add --scope user --transport stdio otm -- <node> <package-root>/bin/otm-claude-mcp.mjs`;
pass each needed `KEY=value` before `--` with the CLI's `--env` option. Verify
the actual registration using `claude mcp get otm` and the signed `otm_history`
tool against the expected canonical run before relying on shared history.

Claude delivers subagent hand-backs, background-task notifications, system
reminders and slash-command echoes through `UserPromptSubmit`. The Claude hook
strips these client frames (`stripHarnessFrames` in `src/core/planner.mjs`)
before classification, so they never start a route, become its goal, or reopen
contract review; a prompt that is only frames still refreshes the capability.
When new source context does arrive and the existing gates already cover it,
call `otm_reconcile` with `contractReviewed: true` after re-reading it; hooks
never set that flag. `otm_snapshot` with `detail: true` keeps one copy of the
source context and caps each entry at 4,000 characters, and shared history no
longer exposes Claude's native session UUID.

The Claude frontend exposes start, reconcile, gate activation, progress,
completion, blocking, audit, resume, checkpoint, exact snapshot, shared history,
and explicit continuation tools. Read tools discover this user's canonical OTM
history across provider sessions and workspaces; mutation tools remain bound
to the exact Claude session. An exact saved run is read from its recorded
primary workspace, regardless of the reader's current folder. This does not
grant arbitrary filesystem access or silently transfer route ownership.
The schemas do not accept provider/session/native IDs. Instead, the official
SessionStart and UserPromptSubmit hooks inject a short-lived capability into
Claude's context. The token contains encrypted claims plus an HMAC signature,
is checked in constant time, and is bound to the workspace. It is refreshed on
each prompt and session start (including compact resume). OTM does not persist
the token in shared history, tool results, task evidence, summaries, or its
diagnostics. Claude Code may retain injected `additionalContext` in its own
local conversation transcript; do not copy the capability into other prompt
fields or artifacts. The key is kept under `OTM_STATE_DIR`; Windows ACL
verification requires only the current user to have full access, while POSIX
uses mode `0600`. The token is a tool capability, not a transcript or
session-history export.

Independent Codex and Claude sessions can start routes in the same folder.
Model-supplied task IDs such as `G1` are local planning labels: if an older
route already owns that stored ID, OTM returns a fresh canonical task ID and
retains the requested label in task metadata. Dependencies and current-task
references follow the canonical IDs. Use the IDs from the returned snapshot.
An unrelated task's ID collision never requires moving folders, replacing a
route, or abandoning the older task.

`otm_history` defaults to `scope: "all"` and returns at most ten compact run
and summary headers per page. `nextOffset` selects the next page; `scope:
"workspace"` restricts discovery to the capability's current workspace. Large
source contracts and full summaries are excluded from this index. Read an exact
saved summary with `runId`, `summaryId`, `offset`, and `maxChars` (default 4,000,
maximum 12,000 characters); its `nextOffset` selects the next text chunk.
`otm_snapshot({runId})` reads the selected canonical route without claiming it.
Claude and Codex use the same saved summary; neither needs to recreate one.

Shared reads do not claim a route. A user must request `/otm continue <runId>`
or call `otm_continue` explicitly. Continuation is denied unless all checks
pass: at least 15 minutes since the last recorded owner activity; a complete,
untruncated OTM event snapshot; and a synchronous, fresh (at most 60 seconds)
trusted host inspection bound to the exact run, owner, route revision, and last
activity event. The inspector must provide current, hashed evidence from both
required sources: `native-broker` and `odc-jobs`. Each source must be complete,
owner-matched, current, and have known work counts; any active or unknown
owner work blocks transfer. Resource claims that belong to the task must be
included in its native broker evidence. OTM does not require a global GPU
availability scan or Manager lease ledger to continue an unrelated task.
Missing history, inspector, source, or receipt fails closed with a host
recovery instruction. The same provider-neutral rule applies in both transfer
directions.

Native Codex MCP starts now derive provider ownership from the matching trusted
`CODEX_THREAD_ID`. When the authentic original Codex session emits a hook for an
older route, OTM atomically attaches the same owner identity and records fresh
activity, guarded by the exact route revision and canonical session binding.
It preserves the route, gates and evidence. Shared reads do not perform this
upgrade. A detached legacy route without verified activity or outstanding-job
coverage remains readable, but cannot be taken over from its timestamp alone;
resume its original host once or recover its exact outstanding work first.

After updating OTM source, reconnect an already-running Claude OTM MCP server
once through `/mcp` so its cached Node modules reload. Hook commands load fresh
source on their next event. This is an update step, not a per-task requirement.

Codex reads the same canonical store through `otm shared-history` and
`otm shared-task --run-id <id>`. For a user-requested Codex continuation, pass
the exact route revision from that snapshot to
`otm continue-task --run-id <id> --expected-revision <revision>`. This CLI path
uses only the active host-provided `CODEX_THREAD_ID`; `--session-id` is rejected
for continuation. It calls the same provider-neutral adapter, trusted host
inspector, and store-level owner/revision/activity compare-and-swap as Claude's
`otm_continue` tool. These reads and continuation do not import native provider
transcripts or copy summaries.

The Codex history CLI uses the same compact projection and paging:

```powershell
otm shared-history --scope all --limit 10 --offset 0 --json
otm shared-history --run-id RUN --summary-id SUMMARY --offset 0 --max-chars 4000 --json
```

Codex hooks bind only the official hook payload's `session_id`. They reject a
missing or conflicting session alias and never substitute the `CODEX_THREAD_ID`
environment variable for absent hook identity. The environment value remains
the CLI's host-provided continuation identity; it is not authority for a hook
event.

The transfer is one store transaction: it compares the source owner, exact
route revision, latest owner activity event, and both canonical session
bindings, then changes the run and appends its evidence-backed transfer event.
The route revision increments so delayed calls from the old owner are fenced.
Unknown legacy sessions remain with their current binding until a human or
trusted host recovery process establishes actual current work state. A chat
closing or a stale timestamp cannot authorize transfer. Provider usage,
transcripts, workers, and agent teams remain independent; OTM neither copies
summaries nor sends messages or dispatches work between providers.

## Trusted host-evidence module contract

The trusted local module is configured independently for the two entry points:
`OTM_HOST_EVIDENCE_MODULE` in the Claude MCP server environment, and
`--host-evidence-module <absolute-path>` to the Claude hook installer. The
installer passes that path only as a local command argument. Set
`OTM_HOST_EVIDENCE_CONFIG` to the absolute trusted configuration JSON for both
the Claude process that launches hooks and the separate MCP server process;
MCP `--env` settings do not propagate to Claude's hook subprocess. The module exports
synchronous `inspectOwnerWork(input)` for continuation and/or
`observeHostHook(input)` for live hook observation. Continuation inspection
must return the versioned complete schema enforced in
[`src/core/continuation.mjs`](../src/core/continuation.mjs); static
not-applicable results are not accepted for required sources.

To keep Claude on the existing Codex canonical database, pass
`--state-dir <absolute-shared-state-directory> --storage sqlite` to the hook
installer. The generated command carries these fixed settings to each hook
before it opens OTM storage or accesses the capability key. Configure the
Claude MCP process with the same `OTM_STATE_DIR` and `OTM_STORAGE=sqlite`.
Cross-provider history requires both processes to use the same directory and
backend; `auto` may select JSON when SQLite is unavailable, which creates a
separate store and is not a valid shared configuration.

The `observeHostHook` callback receives the frozen object:
`{schemaVersion:'otm.host-hook-observation.v1', provider, eventName, payload,
workspaceRoot, nativeSessionId, providerSessionKey, sessionId, run,
routeRevision}`. It must validate official payload identity and route context.
For an ODC job join, use only an exact `PostToolUse.tool_response.jobId` that
matches a durable current record; never trust a job id from `tool_input` or a
model-call argument. The same trusted module observes Codex `SessionStart`,
`PreToolUse`, `PostToolUse`, `SubagentStart`, and `SubagentStop` hooks without
changing the shared Codex MCP source. Codex passes its official `session_id`
and raw event payload; `turn_id` is required only for turn-scoped tool and
subagent events. The pre-tool callback records owner activity before dispatch.
For supported ODC `process_job` mutations, it must durably record the exact
start intent before allowing the call; missing, failed, or incomplete
coverage denies that dispatch. The post-tool callback uses only the official
`tool_response.jobId` and matches it to a current durable ODC record. Subagent
start/stop hooks pair official `agent_id` values into OTM work receipts. A
Codex Stop audit checks the trusted owner-coverage result and the complete OTM
event snapshot; a live child, unmatched tool receipt, unknown host coverage, or
truncated history prevents route finalization. Resume and compact SessionStart
events preserve an existing host coverage epoch and never create a clean one.
Codex hooks load the bundled observer when the default trusted host config
exists; an explicit `OTM_HOST_EVIDENCE_MODULE` overrides that choice. The
packaged Codex hook matcher covers all supported local tools and native
subagent events; Codex does not expose a separate PostToolUseFailure event.
At Codex Stop, a configured observer's incomplete owner coverage or pending ODC
work blocks finalization. The full OTM event snapshot is also required; an
unmatched tool/subagent receipt or truncated history blocks even when no
observer is configured.

When the trusted inspector returns an incomplete evidence object with a
well-formed blocker code, OTM preserves that code in the denied continuation
response. It remains a denial; only fresh, complete, owner-bound evidence can
authorize transfer.

## Root activation and rollback

The source-owned hook installer only merges Claude's supported user settings;
the Claude MCP registration is a separate user-scoped stdio server. Root
reviews and applies both against the existing canonical store. A human applying
the installer should first run the dry run, review its managed event list and
file hashes, then apply using the trusted module path and the canonical state
directory/backend also configured for the Claude MCP server. For example:

```powershell
npm run install:claude-hooks -- --dry-run --state-dir '<canonical-state-dir>' --storage sqlite --host-evidence-module '<absolute-trusted-host-evidence-module>'
npm run install:claude-hooks -- --state-dir '<canonical-state-dir>' --storage sqlite --host-evidence-module '<absolute-trusted-host-evidence-module>'
```

For rollback, use the installer JSON receipt:

```powershell
node scripts/install-claude-hooks.mjs --rollback `
  --backup '<backupPath-from-receipt>' `
  --backup-hash '<backupHash-from-receipt>' `
  --expected-current-hash '<installedHash-from-receipt>'
```

If installation created the settings file, use
`--rollback --remove-created-settings true --expected-current-hash '<installedHash-from-receipt>'`.
Only root-owned live qualification can establish that the active Claude CLI
actually invokes the registered lifecycle hooks and can discover/use all
Claude OTM MCP tools.
