# Trusted local host evidence

`src/core/local-host-evidence.mjs` is the local producer for explicit
provider-neutral OTM continuation. It exports synchronous `inspectOwnerWork`
and `observeHostHook` callbacks. The continuation consumer requires exactly
two sources: `native-broker` and `odc-jobs`. This producer does not inspect
the machine-wide GPU or Manager lease authority; it only checks native
resource claims attached to a relevant broker task.

The inspector accepts the canonical stored route, current owner identity,
route revision, activity event and the consumer's required source list. It
re-reads trusted local stores and writes bounded source receipts; no MCP
tool-argument field is an authority input. The host observer accepts the
current official hook payload, including when `run` is `null` before an OTM
route exists:

```js
observeHostHook({
  schemaVersion: "otm.host-hook-observation.v1",
  provider,
  eventName,
  payload, // unmodified official hook JSON; never persisted
  workspaceRoot,
  nativeSessionId,
  providerSessionKey,
  sessionId,
  run, // current canonical route, or null
  routeRevision, // null with run:null
});
```

The callback returns `observed`, `joined`, a compact `coverage` summary, a
sanitized `code`, and `dispatchAllowed`. The summary contains `complete`,
`epochId`, `pendingCount`, `knownJobCount`, `lastObservedAt`, owner journal
`path`, `sha256`, `mtime`, and `code`. The OTM host applies
`dispatchAllowed === true` only to the supported ODC write routes at
`PreToolUse`. A supported creator is allowed only after its owner intent was
durably recorded. Unsupported potentially mutating routes and failed writes
deny dispatch. A post-hook that cannot be joined leaves the owner unknown;
the already completed tool call cannot be retroactively denied.

## Trusted configuration and owner journal

Configuration is local operator state, never an MCP argument. The default
path is `path.join(os.homedir(), ".claude", "overtli-task-manager",
"host-evidence.json")`, so already-open provider shells can read a newly
installed file. `OTM_HOST_EVIDENCE_CONFIG` may override it only with an
absolute path set by the trusted operator environment. Relative paths,
unknown fields, non-regular files, junctions, oversized files and unsafe
source/receipt overlap fail closed.

The accepted schema contains only these fields:

```json
{
  "schemaVersion": 1,
  "projectRoots": ["D:\\Projects\\Example"],
  "odcRuntimeRoot": "C:\\Users\\Example\\AppData\\Local\\Overtli\\DesktopCommander\\runtime",
  "receiptRoot": "C:\\Users\\Example\\AppData\\Local\\Overtli\\TaskManager\\host-evidence-v1"
}
```

`projectRoots` is limited to 32 absolute roots; the canonical route's absolute
`workspaceRoot` is also inspected. There is no whole-disk search or recursive
project scan. When omitted, `odcRuntimeRoot` and `receiptRoot` use
`%LOCALAPPDATA%\\Overtli\\DesktopCommander\\runtime` and
`%LOCALAPPDATA%\\Overtli\\TaskManager\\host-evidence-v1` respectively.

An official `SessionStart` with `source === "startup"` creates the owner
coverage epoch. The private file is
`<receiptRoot>/owners/<sha256(provider + NUL + nativeSessionId)>.json`, schema
`otm.odc-owner-coverage.v1`. It records the trusted provider/native identity,
startup epoch, bounded owner intents and job joins, provider-contract task
links, and official subagent start/stop pairs. The file is locked while being
rewritten and its content is checked before and after observations. Raw hook
payloads, arguments, `sessionCapability`, continuation tokens and response
bodies are not stored; response and event hashes are retained where needed.

`resume`, `compact`, an arbitrary first `PreToolUse`, or an existing legacy
session does not create a clean epoch. An absent journal can be initialized
only by official startup. A malformed, missing-at-inspection, locked,
changed, capped or incomplete journal is unknown. Unsettled intents are
retained and never evicted; capacity exhaustion makes the owner unknown.

Both providers must carry the exact official `session_id`. Codex tool hooks
also require an official nonempty `turn_id`; `thread_id` is optional. Existing
optional identity aliases are checked for consistency only when present and
never replace `session_id` as authority. Both providers use official
`tool_use_id`/`tool_name`/`tool_input` for tool events and official `agent_id`
for `SubagentStart`/`SubagentStop`. These checks bind an observation to the
supplied native identity; they do not authenticate an arbitrary caller. The
caller must be the trusted provider hook runner.

`UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, and `SessionEnd` return
the current owner coverage read-only. They do not create or reset the startup
epoch, settle pending work, or write another owner-journal event.

## Bounded ODC observation

The consumer routes supported ODC writes through these exact published
operation families and actions:

| Operation                   | Owner-coverage handling                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process_job`               | `start` creates a joined job; `status`, `output`, `list` are read-only; `input` and `cancel` are controls for an exact previously joined owner job.                               |
| `script_job`                | `start` creates a joined job; `status` and `output` are read-only; `cancel` requires the exact joined owner job.                                                                  |
| `process_run`, `script_run` | Synchronous creator; accepted only when its actual response and local durable record show terminal status and no live process marker.                                             |
| `execution_provider`        | `dispatch` and `resume` are treated as possible creators; `status` is read-only; `cancel` requires an exact joined owner job. A response that reuses another job cannot adopt it. |
| `agent_delegate`            | `dispatch` is a possible creator; `status` and `review` are read-only; other actions remain unsupported.                                                                          |
| `orchestration`             | `status`, `wait`, `event`, `completion` are read-only. `schedule`, `resume` and unrecognized actions remain unknown/denied.                                                       |
| `youtube_media`             | `start` may create a job; `status`, `capabilities`, `cleanup`, `export` are read-only.                                                                                            |
| `audio_analysis`            | `start` may create a job; `status`, `capabilities`, `cleanup` are read-only.                                                                                                      |
| `media_proxy_pool`          | `import` and `check` may create jobs; `status` is read-only.                                                                                                                      |
| `provider_contract`         | Claude `create` links an exact native broker task; `status` and `wait` are read-only. Controls require that same linked task and root.                                            |
| `batch_execute`             | `status` and `list` are read-only; all other actions are unsupported for this coverage boundary.                                                                                  |

The compact gateway `mcp__desktop-commander__system_write` may carry one of
these `operationId` values. That value is only a routing discriminator. For
the exact known tool or gateway route, arguments are read only at bounded
top-level or documented `args`/`input` fields. Arbitrary recursive JSON
search is not used. Unknown potentially mutating actions remain unsupported
and keep an owner obligation unresolved. When the exact creation response is
paged or opaque, no partial text or claimed argument ID is accepted; the
intent remains unknown until an exact supported receipt is available.

Only bounded `structuredContent` or `content[0].text` JSON is decoded. The
producer accepts a direct job identity, exact `job` record, or the documented
`process.jobId` plus `process.owner` form. A genuine response identity must
match a durable row in the local ODC store. The MCP transport owner UUID is
preserved as the ODC owner; it is never inferred equal to a native provider
session. A durable join connects that identity to the official native host
session and the immutable creator. Read-only status/output can refresh a
terminal proof for a known creator, but it cannot adopt an existing job.
Input/cancel affects only a previously joined creator and does not replace
that creator identity. Ambiguous cross-native controls fail closed.

Join receipts live at `<receiptRoot>/joins/<sha256(jobId)>.json` and are
immutable by job identity. Owner records retain every supported creation or
control intent from startup and the exact settled join. ODC histories outside
the current owner's exact joins are recorded as uncorrelated global history
and do not poison a complete owner scope. A known owner job with a missing or
mismatched join, an unsettled intent, an interrupted/unknown status, a live
marker, missing terminal proof, capped/unreadable store, or changing
inventory is active or unknown and blocks continuation. The reader uses
schema 1 `process-jobs.json`, `owned-processes.json`, and
`idempotency.json`, with bounds of 200 jobs, 1,024 live markers, 500
idempotency rows, and 256 KiB for the owned-process inventory. Files are
stable regular-file reads and are re-read before negative absence is
accepted.

## Native broker and terminal proof

For each trusted project root, the producer checks only immediate task
directories under `.codex/overtli-orchestration`. It reads at most 256 task
directories per root, 128 task directories total, 64 workers per task and
the last 128 operations per worker. Capped lists, unsafe paths, missing
registered state, unreadable state, writer/routing locks or inspection-time
drift are unknown. A missing broker directory under a readable trusted root
is a bounded empty inventory.

An empty/unregistered scaffold directory is excluded from broker scope only
when it has no canonical registration marker and no verified current-owner
task link. The observed directory names, mtime and hash are recorded and
rechecked. A symlink, cap, marker, linked task or changing directory is
unknown. Canonical markers include `state-v1.json`, `native-routing.json`,
`writer.lock`, `native-routing.lock`, `events.jsonl`, `events.ndjson`, and
`contract.json`.

Task relevance is established by exact `contract.ownerSessionId`, a trusted
worker binding targeting the current native session, or a provider-contract
link observed from an official Claude ODC response and then matched against
the actual task state at the configured root. Claude's broker owner is the
ODC transport principal (`claude:<transport UUID>`), not Claude's native
`session_id`; the verified link preserves both identities. The provider
contract continuation token is never retained. Native-routing sidecars are
not required for Claude tasks. Unrelated task leases are filtered before
counting.

Relevant task worker state must have a current exact binding, attempt and
package/revision evidence. Active/unknown operations, retained ownership,
cancellation, steering invalidation, eligible external waits and locks
block. If both `resourceGraph` and `resourceRuntime` are absent, the broker
has no broker-issued resource leases to inspect. A declared graph without a
runtime lease inventory is unknown. Relevant runtime `ACTIVE` and `UNCERTAIN`
leases block regardless of expiry; resolved `COMMITTED`, `ABORTED`,
`RELEASED`, `EXPIRED`, `COMPLETED`, and cancelled states do not.

`COMPLETED` or other terminal worker status, a settled flag, or a broker
packet alone is not physical terminal proof. The current exact child and
attempt need either a verified `codex-native-host` receipt in the owned
worker evidence namespace or a matching official `SubagentStart` and
`SubagentStop` pair retained by this owner journal for Codex or Claude. The
pair must match the current child binding and occur at or after its latest
binding/resume. Legacy unobserved workers remain unknown. Proof receipts keep
their original provider observation time and hash. A new inspection records
current source file hashes, mtimes and inspection time; it never relabels an
old terminal event as new host activity.

This continuation policy differs from the native adapter's replacement or
retry binding policy: continuation may make a fresh read-only check of a
retained exact terminal proof older than 60 seconds. A replacement/retry
still requires fresh physical host evidence from its native routing path,
and a later resume requires a new terminal proof after that resume.

## Evidence limits and verification

The inspector records two `otm.host-source-observation.v1` receipts per
successful inspection under `<receiptRoot>/inspections`. Each contains the
source-specific predicates, current hashes/mtimes, scan bounds, truncation,
activity event ID, owner, route revision and inspection time. The result is
complete only when both sources and receipt writes are complete and no source
reports unknown work. Missing configuration, legacy owner coverage, absent
or unreadable inventory, unjoined supported creation, source cap, active
work, lock or material drift never means “no work.”

The evidence boundary covers the configured OTM project roots, the exact
ODC local job stores, official provider hook events and their linked native
broker records. It cannot prove that an operator or unrelated program did
not bypass those authorities and start work outside the recorded processes,
hooks and broker bindings. It also does not authorize cross-provider team
delegation or adoption of active jobs.

Focused validation from the OTM package:

```powershell
node --check src/core/local-host-evidence.mjs
node --test tests/local-host-evidence.test.mjs
```

The focused cases cover retained terminal proof after the idle threshold,
exact ODC joining and owner filtering, Codex identity aliases, opaque/paged
creation denial, unregistered broker-folder exclusion, registered missing
state, Codex and Claude official subagent proofs, Claude transport-owner task
linking, forged response rejection, worker drift, relevant expired leases,
resolved lease states, and the actual local ODC inventory read-only.
