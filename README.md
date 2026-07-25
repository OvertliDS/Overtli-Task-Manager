# 🧭 Overtli Task Manager

**Codex-first task control for serious engineering.**

Overtli Task Manager (OTM) structures AI coding sessions into evidence-backed routes. It enforces a strict, checklist-driven development flow to ensure complete, verified implementations without premature session stops.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-OvertliDS-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/OvertliDS)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-overtlids-5F7FFF?logo=kofi&logoColor=white)](https://ko-fi.com/overtlids)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-overtlids-FFDD00?logo=buymeacoffee&logoColor=000000)](https://www.buymeacoffee.com/overtlids)

---

## Key Capabilities

- **Route Checklists:** Deconstruct complex goals into discrete segments (`pending` ➔ `active` ➔ `done` / `blocked`).
- **Evidence Enforcement:** Tasks can only be marked complete once concrete proof (changed files, test results, command outputs) is provided.
- **Chat Integration:** Renders real-time, user-friendly Markdown progress dashboards directly in your Codex chat.
- **Persistent Task List:** Keeps a full checked-off task list in chat Markdown and the current chat's session-scoped `current.json.checklist`.
- **Concurrent Session Isolation:** Keys routes by normalized workspace plus `CODEX_THREAD_ID` (or explicit `sessionId`), so separate chats and VS Code windows cannot replace each other's work.
- **Durable State Cache:** Syncs canonical routes under `.codex/overtli-task-manager/sessions/<session-key>/`; top-level `current.json` and `current.md` provide a workspace-wide session index.
- **Optimized Rendering:** Shows a full checklist at route start and finalization, then compact progress cards during routine work.
- **Task Normalization:** Keeps one active route segment where possible, blocks manual jumps until the active task is handled, and lets reconciliation intentionally add, merge, reopen, or reorder work.
- **Model-Guided Three-Tier Routes:** Represents major outcomes as route gates, substantive explicit/inferred work as internal subtasks, and concrete actions as nested mini-steps without prescribing generic domain content.
- **Recursive Evidence Gates:** Prevents a route gate from closing until model review is current, every required internal subtask and mini-step is terminal with required evidence, and the gate itself has completion evidence.
- **Accumulated Source Contract:** Normalizes bounded inline/pasted text, structured prompt context, attachment/OCR text, and visual descriptions with provenance and revision digests across steering, restart, summaries, and export/import.
- **Lifecycle Hooks:** Intercepts sessions, prompts, tools, and stops to enforce task completion and audit progress.
- **Workspace Memory:** Keeps a lightweight, high-signal index of project guides (`AGENTS.md`), memory banks, and schemas.
- **Managed Instruction Sync:** Can refresh only OTM's marked `AGENTS.md` block after an explicitly trusted installation opts in; ordinary sessions never modify project instructions.

---

## Installation

### 1. Install Plugin

Clone the repository directly into the standard Codex plugins directory:

```bash
# Clone to standard Codex plugins directory
git clone https://github.com/OvertliDS/Overtli-Task-Manager.git ~/.codex/plugins/overtli-task-manager

# Install dependencies
cd ~/.codex/plugins/overtli-task-manager
npm install
```

## Operations and recovery

- [Architecture](docs/ARCHITECTURE.md)
- [Migration guide](docs/MIGRATION.md)
- [Backup and restore](docs/BACKUP_RESTORE.md)
- [Repair guide](docs/REPAIR.md)
- [Uninstall guide](docs/UNINSTALL.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Security policy](SECURITY.md)

### Environment variables

| Variable                       | Default                                           | Purpose                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTM_STORAGE`                  | `auto`                                            | Select `auto`, `sqlite`, or `json`; `sqlite` fails if the native backend is unavailable.                                                                                                |
| `OTM_STATE_DIR`                | `OTM_HOME` or `<CODEX_HOME>/overtli-task-manager` | Override the durable store directory.                                                                                                                                                   |
| `OTM_HOME`                     | `<CODEX_HOME>/overtli-task-manager`               | Base durable state directory when `OTM_STATE_DIR` is not set.                                                                                                                           |
| `CODEX_HOME`                   | `~/.codex`                                        | Codex home used for global installation and the default OTM state location.                                                                                                             |
| `OTM_SESSION_ID`               | host supplied                                     | Explicit session identity, after request payload fields and before `CODEX_THREAD_ID`.                                                                                                   |
| `CODEX_THREAD_ID`              | host supplied                                     | Fallback session identity when no explicit request/session ID is available.                                                                                                             |
| `OTM_CLAIM_LEGACY_ROUTE`       | `0`                                               | Set to `1` only to explicitly adopt a legacy unscoped route.                                                                                                                            |
| `OTM_AUTO_SYNC_AGENTS`         | enabled                                           | Set to `0` to stop hooks from creating or refreshing OTM's marker-delimited root `AGENTS.md` block.                                                                                     |
| `OTM_AUTO_START_ROUTE`         | enabled                                           | Set to `0` to disable automatic creation of an OTM route for a substantive new prompt. This creates OTM's durable route, not a host-native Codex goal.                                  |
| `OTM_AUTO_REBUILD_SQLITE`      | enabled                                           | Set to `0` to disable the one-shot `better-sqlite3` rebuild after a detected Node ABI mismatch. CI suppresses the rebuild unless this is explicitly `1`.                                |
| `OTM_AUTO_INSTALL_GLOBAL`      | disabled                                          | Set to `1` only to explicitly permit postinstall global setup.                                                                                                                          |
| `OTM_RECORD_PRE_TOOL`          | disabled                                          | Set to `1` to record pre-tool observations.                                                                                                                                             |
| `OTM_TRACK_MCP_EVIDENCE`       | disabled                                          | Set to `1` to record configured MCP tool evidence.                                                                                                                                      |
| `OTM_STOP_AUTO_FINALIZE`       | enabled                                           | Set to `0` to disable default Stop-hook finalization and require manual `otm_finalize_turn` / `otm_clear_current`.                                                                      |
| `OTM_DEDUPE_HOOKS`             | enabled                                           | Set to `0` to disable cross-install hook deduplication.                                                                                                                                 |
| `OTM_HOOK_DEDUPE_TTL_MS`       | `10000`                                           | Hook dedupe claim lifetime in milliseconds.                                                                                                                                             |
| `OTM_PROJECT_REVIEW_MAX_FILES` | `20`                                              | Maximum eligible project-review files read at session start.                                                                                                                            |
| `OTM_COMMAND_CAPTURE`          | `redacted`                                        | Command-evidence policy: `redacted` stores redacted commands/scratch, `none` stores no command text, and `validation-only` stores command text only for recognized validation commands. |
| `CI`                           | unset                                             | Suppresses postinstall global setup even if `OTM_AUTO_INSTALL_GLOBAL=1`; CI never mutates global Codex state.                                                                           |

#### Verify the SQLite backend

`better-sqlite3` is a required dependency so CI and production installations
cannot silently omit the SQLite backend. JSON remains a supported explicit
storage selection (`OTM_STORAGE=json`). After `npm ci` or `npm install`, verify the
actual native module instead of relying on the declaration in `package.json`:

```bash
npm ls better-sqlite3 --depth=0
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); console.log(db.prepare('select sqlite_version() version').get()); db.close()"
node ./bin/otm.mjs doctor
```

`OTM_STORAGE=auto` verifies the native binding by opening an in-memory database,
not merely by loading the package's JavaScript wrapper. If the binding was built
for a different Node ABI, OTM makes one concurrency-guarded, two-minute rebuild
attempt with the npm installation associated with the active Node executable,
then retries SQLite. Global configuration installation remains disabled during
this repair.

If repair is disabled or unsuccessful, `auto` continues with the JSON backend
and preserves any existing SQLite file unchanged. `otm doctor` reports the
fallback and the inactive SQLite path so the backend switch is visible. Set
`OTM_STORAGE=sqlite` to make any unavailable native runtime a hard error:

```powershell
$env:OTM_STORAGE = 'sqlite'
node ./bin/otm.mjs doctor
```

If `npm ls` is empty, reinstall the version range declared by this project and
show native install output:

```bash
npm install better-sqlite3@^11.9.1 --foreground-scripts
```

If the package is present but the load test reports different
`NODE_MODULE_VERSION` values, rebuild it under the same Node executable that
launches OTM:

```bash
npm rebuild better-sqlite3 --foreground-scripts
```

Use a supported Node.js release (this project requires Node 20.10 or newer;
the currently tested Windows setup uses Node 24). `better-sqlite3` normally
downloads a prebuilt binary for supported LTS releases. If no prebuilt binary
exists for the selected Node/architecture combination, Windows source builds
require Python plus Visual Studio Build Tools with the **Desktop development
with C++** workload. Re-run the install after those prerequisites are active,
then repeat the load test above. The upstream package's
[compilation](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md)
and [troubleshooting](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)
guides are the authoritative reference for uncommon toolchain failures.

`npm install` does not mutate global Codex configuration. To perform a global install, run `otm install-global` explicitly, or set `OTM_AUTO_INSTALL_GLOBAL=1` only in a consciously trusted install environment. Existing global hooks are backed up and unrelated entries are preserved.

> [!NOTE]
> On Windows, the standard path is `%USERPROFILE%\.codex\plugins\overtli-task-manager`.

### 2. Configure Codex

Generate the MCP server block with the installed copy of OTM, then paste the absolute-path output into your global configuration at `~/.codex/config.toml`:

```bash
node ./bin/otm.mjs mcp-config
```

> [!TIP]
> Run that command from the OTM installation directory. The generated TOML uses the absolute `bin/otm-mcp.mjs` path so Codex does not depend on `~` expansion.

### 3. Install in Target Workspace

Initialize OTM in any target repository to patch its `AGENTS.md`, hooks, skills, and `.gitignore`:

```bash
# From target repository root
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs install
```

Install or refresh OTM hooks and skills globally for every Codex workspace:

```bash
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs install-global
```

This idempotently merges OTM lifecycle hooks into `~/.codex/hooks.json` without removing unrelated hooks and copies the packaged skills into `~/.codex/skills`. Use `--codex-home PATH` for a non-default Codex home.

`otm install` patches root `AGENTS.md` by default. If a repository has `AGENTS.override.md`, the installer reports a warning and leaves it untouched unless you explicitly run:

```bash
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs install --agents-file AGENTS.override.md
```

Preview removal before applying it. `otm uninstall` removes only OTM-managed
marker blocks, structurally identified OTM hook commands, and packaged skill
directories whose contents still match the installed package. It preserves
route state and summaries unless `--remove-state` is also explicitly confirmed.

```bash
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs uninstall --dry-run
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs uninstall --confirm
```

Global removal follows the same preview-and-confirm flow and preserves any
modified packaged skill directories and unrelated hooks:

```bash
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs uninstall --global --dry-run
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs uninstall --global --confirm
```

When the plugin's `SessionStart` hook is active, it creates or refreshes only OTM's marker-delimited block in the root `AGENTS.md`. `UserPromptSubmit` repeats that check so a workspace opened before the hook was installed self-repairs on its first prompt. Existing content outside markers is preserved, incomplete marker pairs are reported without being overwritten, and nested package manifests do not shadow the enclosing Git root. Set `OTM_AUTO_SYNC_AGENTS=0` to opt out for a workspace or host environment.

To verify the setup:

```bash
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs doctor
```

---

## Developer Reference

### MCP Tools

| Tool                    | Category                   | Purpose                                                                    |
| ----------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `otm_start`             | Route Control              | Initialize a new route with goals and subtasks                             |
| `otm_reconcile`         | Route Control              | Update the route when goals steer or scope changes                         |
| `otm_snapshot`          | Route Control              | Get current route state as Markdown/JSON                                   |
| `otm_start_task`        | Progress                   | Set a specific route segment as active                                     |
| `otm_progress`          | Progress                   | Record checkpoints and update progress                                     |
| `otm_complete_task`     | Progress                   | Mark a segment as done with required evidence                              |
| `otm_block_task`        | Progress                   | Mark a segment as blocked with blocker details                             |
| `otm_drop_task`         | Progress                   | Drop or supersede stale/unneeded segments                                  |
| `otm_audit_stop`        | Completion                 | Check if all required route segments are completed                         |
| `otm_finalize_turn`     | Completion                 | Save turn summary and update project memory                                |
| `otm_clear_current`     | Completion                 | Clear active route state files                                             |
| `otm_abandon`           | Completion                 | Explicitly abandon unfinished route work with a recorded reason            |
| `otm_cleanup_workspace` | Completion                 | Clean OTM-owned temp and scratch artifacts                                 |
| `otm_prune_history`     | Completion                 | Prune durable run/task/event/summary/cache history older than retention    |
| `otm_project_review`    | Memory                     | Index high-signal repository context                                       |
| `otm_memory_search`     | Memory                     | Search stored checkpoints and decision records                             |
| `otm_memory_upsert`     | Admin / Memory Maintenance | Create or update concise project memory entries                            |
| `otm_memory_delete`     | Admin / Memory Maintenance | Delete stale project memory entries by id, kind, or tag                    |
| `otm_install_workspace` | Admin / Install            | Idempotently install OTM into a repository                                 |
| `otm_doctor`            | Admin / Diagnostics        | Diagnose OTM storage, active route state, current files, and install state |

### CLI Interface

```bash
otm install [--workspace PATH] [--dry-run] [--with-project-mcp-config]
            [--agents-file AGENTS.override.md]
otm install-global [--codex-home PATH] [--dry-run]
otm uninstall [--workspace PATH] [--dry-run] [--confirm] [--remove-state]
otm uninstall --global [--codex-home PATH] [--dry-run] [--confirm]
otm doctor [--workspace PATH] [--session-id ID] [--repair] [--dry-run] [--json]
otm migrate [--dry-run] [--json]
otm backup [--output PATH] [--dry-run] [--json]
otm restore --input PATH --confirm [--dry-run] [--json]
otm repair [--workspace PATH] [--dry-run] [--json]
otm export --output PATH [--workspace PATH] [--dry-run] [--json]
otm import --input PATH --confirm [--workspace PATH] [--dry-run] [--json]
otm resume --run-id ID [--task-id ID] [--reason TEXT] [--workspace PATH] [--json]
otm archive --run-id ID --confirm [--reason TEXT] [--workspace PATH] [--json]
otm abandon --run-id ID --reason TEXT --confirm [--delete-files] [--workspace PATH] [--json]
otm snapshot [--workspace PATH] [--session-id ID]
otm review-project [--workspace PATH] [--max-files N]
otm clear-current [--workspace PATH] [--session-id ID] [--delete-files]
otm cleanup [--workspace PATH] [--min-age-ms N] [--scratch-max-age-ms N] [--dry-run]
otm prune-history [--workspace PATH] [--retention-days N] [--dry-run]
otm mcp-config
```

---

## State & Storage Architecture

OTM maintains separation between session-level and persistent data:

```text
Global Durable Store (~/.codex/overtli-task-manager/)
 ├── state.sqlite (SQLite with WAL mode when the native runtime is usable)
 └── state.json (automatic or explicit JSON backend; SQLite files are preserved)

Workspace State (.codex/overtli-task-manager/)
 ├── current.json / current.md (Workspace index of active Codex sessions)
 ├── sessions/<session-key>/
 │   ├── current.json / current.md (Canonical route for one Codex chat)
 │   └── cache/scratch/ (Session-owned raw hook/tool payloads)
 ├── cache/ (Lightweight context and review caches)
 │   ├── tmp/ (Atomic write staging; stale OTM temp files are cleaned automatically)
 │   └── scratch/ (Raw hook/tool payloads kept out of user-facing Markdown)
 └── summaries/ (Historical turn summaries)
```

### State Files

| File / Folder                                   | Purpose                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `current.json` / `current.md`                   | Workspace-wide index; never use it as a mutable route when session scoping is active                   |
| `sessions/<session-key>/current.md`             | Chat-friendly canonical route checklist for one Codex session                                          |
| `sessions/<session-key>/current.json`           | Canonical gate/subtask/mini-step hierarchy, accumulated source contract, evidence, and lifecycle state |
| `sessions/<session-key>/current.json.checklist` | Compact machine-readable gate checklist for that session's UIs and hooks                               |
| `cache/tmp`                                     | Atomic write staging and stale `current.*.tmp` cleanup                                                 |
| `cache/scratch`                                 | Short-lived raw tool payloads referenced by route evidence                                             |
| `summaries/`                                    | Historical turn summaries                                                                              |

`otm_clear_current` cleans active state plus OTM-owned temp/scratch files at
route completion. `otm_cleanup_workspace` exposes the same cleanup directly.
Durable history cleanup is separate: `otm_prune_history` / `otm prune-history`
removes old inactive runs, tasks, events, summaries, and cache entries while
preserving active, blocked, and paused routes.

### Route Display

| Moment                    | Rendered Output         |
| ------------------------- | ----------------------- |
| Route start               | Full checklist          |
| Routine progress          | Compact status card     |
| Steering or manual status | Full snapshot           |
| Finalization              | Full completion summary |

Each session-scoped `current.json` tracks render metadata (`renderRevision`, `lastRenderedMode`,
`lastRenderedTaskId`, `lastRenderedHash`) so agents and UIs can avoid repeating
the full checklist unnecessarily.

### Concurrent chats and windows

OTM resolves a session from explicit `sessionId`/hook session, thread, or
conversation fields, then `OTM_SESSION_ID`, then `CODEX_THREAD_ID`. Active-run
lookup always includes both the workspace and that session.
`replaceExisting=true` therefore replaces only the current session's route.
Explicit `runId` calls are rejected when the run belongs to another workspace
or session.

Legacy unscoped routes are not adopted automatically because doing so could
attach another chat's stale checklist to a new session. Set
`OTM_CLAIM_LEGACY_ROUTE=1` only for an intentional one-time migration. Unscoped
route creation is rejected while scoped routes are active, and unscoped
diagnostics cannot overwrite the workspace session index.

SQLite uses WAL mode and a workspace/session index. The JSON fallback uses a
cross-process lock for mutations so concurrent Codex processes do not lose one
another's runs. Session-owned scratch cleanup does not delete another active
chat's evidence.

### Route Planning

1. The model reviews the complete accumulated source contract before work:
   typed/pasted text, structured context, attachment/OCR text, visual
   descriptions, identifiers, constraints, ordering, and acceptance conditions.
2. Tier 1 `tasks` are bounded completion gates for major outcomes, such as
   Phase 3. They carry a concise outcome/gist, dependencies, source references,
   acceptance conditions, a model-interpreted `workType`, and a gate evidence
   policy where useful.
   Mixed prompts keep distinct gate intent: planning, review, research,
   documentation, implementation, validation, release, deployment, operations,
   `mixed`, or a justified custom label. The route reports `routeIntent.mode`
   as `mixed` when its gates differ instead of coercing the whole request into
   one lossy category.
3. Tier 2 `internalSteps` preserve explicit children such as Phase 3.1/3.2. If
   no children are stated, the model infers only the smallest complete
   outcome-specific subtasks from the whole contract.
4. Tier 3 `miniSteps` are concrete verifiable actions needed to finish one
   non-atomic internal subtask. A genuinely atomic subtask sets `atomic=true`
   and includes `atomicRationale`.
5. OTM owns structural validation and recursive lifecycle gates; the model
   owns domain content. It must not populate every gate with the same canned
   checklist.
6. The deterministic fallback preserves only a visible
   `needsModelReview` scaffold. It cannot be completed and must be replaced by
   a model-authored hierarchy through `otm_reconcile`.
7. Reconciliation re-reviews all accumulated sources, appends new steering,
   keeps explicit wording/order and valid IDs/evidence, records supersession,
   re-evaluates gate work types, and reopens only invalidated work. Completion
   evidence follows the gate intent: a review can close on evidence-backed
   findings, while implementation still requires implementation, integration,
   validation, and synchronized documentation where affected.

OTM keeps one current task whenever possible. Manual task switching is blocked
while another required task is active unless reconciliation or an explicit
override allows it.

### Internal Step Gates

| Rule                                                                                                                                    | Effect                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Internal subtasks and mini-steps normalize to durable records with stable IDs, provenance, criteria, dependencies, evidence, and status | Handoffs resume at the exact descendant                                         |
| Non-atomic internal subtasks require one or more outcome-specific mini-steps                                                            | A subtask cannot hide unfinished concrete work                                  |
| Atomic subtasks require an explicit rationale                                                                                           | “Atomic” cannot become a silent shortcut                                        |
| `otm_progress` updates either tier by exact id, title, index, or object                                                                 | Evidence and timestamps stay attached to the work they prove                    |
| Required descendants must be `done` or intentionally `skipped` with required evidence                                                   | Pending, active, blocked, or unreviewed descendants keep the parent gate closed |
| `otm_complete_task` still requires gate evidence                                                                                        | Descendant completion never substitutes for segment acceptance                  |

### Hooks And Completion

| Area               | Behavior                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP results        | Markdown/plain-text first; full JSON remains available through `otm://current`                                                                                    |
| Passive hooks      | Touch route state only when the current Codex session is identifiable                                                                                             |
| Duplicate installs | Cross-process invocation claims suppress duplicate global/workspace hook output                                                                                   |
| Evidence tracking  | Defaults to file edits, validation/build commands, failures, and explicit OTM checkpoints                                                                         |
| Opt-ins            | `OTM_RECORD_PRE_TOOL=1`, `OTM_TRACK_MCP_EVIDENCE=1`, `OTM_CLAIM_LEGACY_ROUTE=1`; set `OTM_AUTO_SYNC_AGENTS=0` only to opt out of root instruction synchronization |
| Finalization       | Stop-hook finalization is enabled by default; set `OTM_STOP_AUTO_FINALIZE=0` only to require manual finalization and clearing                                     |
| Hook timeouts      | SessionStart 15s, UserPromptSubmit 12s, PreToolUse 8s, PostToolUse 12s, Pre/PostCompact 15s, Stop 45s                                                             |

Normal closeout is automatic and model-visible. Run `otm_audit_stop`; if
required work remains, continue the active route. Once the audit passes, the
Stop hook automatically writes the durable summary and checkpoint memory,
clears the active route, and blocks once with the saved Markdown summary so
Codex can send the final user-facing reply. The host-marked follow-up Stop is
released to bound the loop. Set `OTM_STOP_AUTO_FINALIZE=0` only when a client
must manually call `otm_finalize_turn`, present its summary, and then call
`otm_clear_current`. Stop-hook execution failures fail open with a warning,
while explicit `otm_audit_stop` remains the authoritative completion check.

For a substantive new implementation request, `UserPromptSubmit` creates a
conservative session-scoped bootstrap route before the model edits files unless
`OTM_AUTO_START_ROUTE=0`. The hook then instructs the model to re-review the
complete accumulated source contract and replace the non-completable fallback
with a three-tier route. Later prompt/attachment/visual steering is appended to
the canonical contract and marks review pending until a model reconciliation
updates the hierarchy. Completing a gate requires terminal evidence-backed
descendants plus gate evidence, then atomically activates the next eligible
gate. OTM preserves the hierarchy and context across pauses and reloads. Hooks
and MCP cannot invoke Codex's private goal API themselves, but
their managed instructions and prompt context direct Codex to create one native
goal when that control is available, keep it active through all OTM segments,
and terminally update it only after the OTM stop audit.

---

## License

MIT
