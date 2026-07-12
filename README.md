# 🧭 Overtli Task Manager

**Codex-first task control for serious engineering.**

Overtli Task Manager (OTM) structures AI coding sessions into evidence-backed routes. It enforces a strict, checklist-driven development flow to ensure complete, verified implementations without premature session stops.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-OvertliDS-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/OvertliDS)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-overtlids-5F7FFF?logo=kofi&logoColor=white)](https://ko-fi.com/overtlids)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-overtlids-FFDD00?logo=buymeacoffee&logoColor=000000)](https://www.buymeacoffee.com/overtlids)

---

## Key Capabilities

*   **Route Checklists:** Deconstruct complex goals into discrete segments (`pending` ➔ `active` ➔ `done` / `blocked`).
*   **Evidence Enforcement:** Tasks can only be marked complete once concrete proof (changed files, test results, command outputs) is provided.
*   **Chat Integration:** Renders real-time, user-friendly Markdown progress dashboards directly in your Codex chat.
*   **Persistent Task List:** Keeps a full checked-off task list in chat Markdown and the current chat's session-scoped `current.json.checklist`.
*   **Concurrent Session Isolation:** Keys routes by normalized workspace plus `CODEX_THREAD_ID` (or explicit `sessionId`), so separate chats and VS Code windows cannot replace each other's work.
*   **Durable State Cache:** Syncs canonical routes under `.codex/overtli-task-manager/sessions/<session-key>/`; top-level `current.json` and `current.md` provide a workspace-wide session index.
*   **Optimized Rendering:** Shows a full checklist at route start and finalization, then compact progress cards during routine work.
*   **Task Normalization:** Keeps one active route segment where possible, blocks manual jumps until the active task is handled, and lets reconciliation intentionally add, merge, reopen, or reorder work.
*   **Internal Step Gates:** Keeps each route segment honest by requiring internal steps to be checked off as work happens before the parent segment can be completed.
*   **Lifecycle Hooks:** Intercepts sessions, prompts, tools, and stops to enforce task completion and audit progress.
*   **Workspace Memory:** Keeps a lightweight, high-signal index of project guides (`AGENTS.md`), memory banks, and schemas.
*   **Managed Instruction Sync:** Can refresh only OTM's marked `AGENTS.md` block after an explicitly trusted installation opts in; ordinary sessions never modify project instructions.

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

| Variable | Default | Purpose |
|---|---|---|
| `OTM_STORAGE` | `auto` | Select `auto`, `sqlite`, or `json`; `sqlite` fails if the native backend is unavailable. |
| `OTM_STATE_DIR` | `OTM_HOME` or `<CODEX_HOME>/overtli-task-manager` | Override the durable store directory. |
| `OTM_HOME` | `<CODEX_HOME>/overtli-task-manager` | Base durable state directory when `OTM_STATE_DIR` is not set. |
| `CODEX_HOME` | `~/.codex` | Codex home used for global installation and the default OTM state location. |
| `OTM_SESSION_ID` | host supplied | Explicit session identity, after request payload fields and before `CODEX_THREAD_ID`. |
| `CODEX_THREAD_ID` | host supplied | Fallback session identity when no explicit request/session ID is available. |
| `OTM_CLAIM_LEGACY_ROUTE` | `0` | Set to `1` only to explicitly adopt a legacy unscoped route. |
| `OTM_AUTO_SYNC_AGENTS` | disabled | Set to `1` to request managed `AGENTS.md` block synchronization; it also requires `OTM_TRUSTED_INSTALLATION=1`. |
| `OTM_TRUSTED_INSTALLATION` | disabled | Set to `1` only for a trusted OTM installation. Required together with `OTM_AUTO_SYNC_AGENTS=1` before a session hook may modify `AGENTS.md`. |
| `OTM_AUTO_START_ROUTE` | enabled | Set to `0` to disable automatic creation of an OTM route for a substantive new prompt. This creates OTM's durable route, not a host-native Codex goal. |
| `OTM_AUTO_INSTALL_GLOBAL` | disabled | Set to `1` only to explicitly permit postinstall global setup. |
| `OTM_RECORD_PRE_TOOL` | disabled | Set to `1` to record pre-tool observations. |
| `OTM_TRACK_MCP_EVIDENCE` | disabled | Set to `1` to record configured MCP tool evidence. |
| `OTM_STOP_AUTO_FINALIZE` | disabled | Set to `1` only to use Stop-hook finalization fallback. |
| `OTM_DEDUPE_HOOKS` | enabled | Set to `0` to disable cross-install hook deduplication. |
| `OTM_HOOK_DEDUPE_TTL_MS` | `10000` | Hook dedupe claim lifetime in milliseconds. |
| `OTM_PROJECT_REVIEW_MAX_FILES` | `20` | Maximum eligible project-review files read at session start. |
| `OTM_COMMAND_CAPTURE` | `redacted` | Command-evidence policy: `redacted` stores redacted commands/scratch, `none` stores no command text, and `validation-only` stores command text only for recognized validation commands. |
| `CI` | unset | Suppresses postinstall global setup even if `OTM_AUTO_INSTALL_GLOBAL=1`; CI never mutates global Codex state. |

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

`otm doctor` should report `Storage: sqlite`. To make a missing native module a
hard error during diagnosis instead of allowing the JSON fallback:

```powershell
$env:OTM_STORAGE = 'sqlite'
node ./bin/otm.mjs doctor
```

If `npm ls` is empty, reinstall the version range declared by this project and
show native install output:

```bash
npm install better-sqlite3@^11.9.1 --foreground-scripts
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

When the plugin's `SessionStart` hook is active, it leaves `AGENTS.md` untouched by default. A deliberately trusted installation may opt into synchronization with both `OTM_AUTO_SYNC_AGENTS=1` and `OTM_TRUSTED_INSTALLATION=1`; only then does OTM create or refresh its managed block in the enclosing Git workspace. Existing content outside markers is preserved, incomplete marker pairs are reported without being overwritten, and nested package manifests do not shadow the enclosing Git root.

To verify the setup:
```bash
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs doctor
```

---

## Developer Reference

### MCP Tools
| Tool | Category | Purpose |
|---|---|---|
| `otm_start` | Route Control | Initialize a new route with goals and subtasks |
| `otm_reconcile` | Route Control | Update the route when goals steer or scope changes |
| `otm_snapshot` | Route Control | Get current route state as Markdown/JSON |
| `otm_start_task` | Progress | Set a specific route segment as active |
| `otm_progress` | Progress | Record checkpoints and update progress |
| `otm_complete_task` | Progress | Mark a segment as done with required evidence |
| `otm_block_task` | Progress | Mark a segment as blocked with blocker details |
| `otm_drop_task` | Progress | Drop or supersede stale/unneeded segments |
| `otm_audit_stop` | Completion | Check if all required route segments are completed |
| `otm_finalize_turn` | Completion | Save turn summary and update project memory |
| `otm_clear_current` | Completion | Clear active route state files |
| `otm_abandon` | Completion | Explicitly abandon unfinished route work with a recorded reason |
| `otm_cleanup_workspace` | Completion | Clean OTM-owned temp and scratch artifacts |
| `otm_prune_history` | Completion | Prune durable run/task/event/summary/cache history older than retention |
| `otm_project_review`| Memory | Index high-signal repository context |
| `otm_memory_search` | Memory | Search stored checkpoints and decision records |
| `otm_memory_upsert` | Admin / Memory Maintenance | Create or update concise project memory entries |
| `otm_memory_delete` | Admin / Memory Maintenance | Delete stale project memory entries by id, kind, or tag |
| `otm_install_workspace` | Admin / Install | Idempotently install OTM into a repository |
| `otm_doctor` | Admin / Diagnostics | Diagnose OTM storage, active route state, current files, and install state |

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
 └── state.sqlite (SQLite with WAL mode; falls back to JSON if sqlite3 is missing)

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

| File / Folder | Purpose |
|---|---|
| `current.json` / `current.md` | Workspace-wide index; never use it as a mutable route when session scoping is active |
| `sessions/<session-key>/current.md` | Chat-friendly canonical route checklist for one Codex session |
| `sessions/<session-key>/current.json.checklist` | Compact machine-readable checklist for that session's UIs and hooks |
| `cache/tmp` | Atomic write staging and stale `current.*.tmp` cleanup |
| `cache/scratch` | Short-lived raw tool payloads referenced by route evidence |
| `summaries/` | Historical turn summaries |

`otm_clear_current` cleans active state plus OTM-owned temp/scratch files at
route completion. `otm_cleanup_workspace` exposes the same cleanup directly.
Durable history cleanup is separate: `otm_prune_history` / `otm prune-history`
removes old inactive runs, tasks, events, summaries, and cache entries while
preserving active, blocked, and paused routes.

### Route Display

| Moment | Rendered Output |
|---|---|
| Route start | Full checklist |
| Routine progress | Compact status card |
| Steering or manual status | Full snapshot |
| Finalization | Full completion summary |

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

1. Routes should be split into separate segments for the main phases, steps,
   issues, problems, and deliverables.
2. Segments can include `internalSteps` or
   `metadata.internalSteps` for explicit, inferred, researched, and discovered
   subwork.
3. Fallback planning splits obvious phases, steps, issues, and deliverables
   when only a goal or prompt is supplied.
4. `otm_reconcile` can merge, add, reorder, or reopen tasks when the route
   changes; reopened tasks keep prior evidence and reopening metadata.

OTM keeps one current task whenever possible. Manual task switching is blocked
while another required task is active unless reconciliation or an explicit
override allows it.

### Internal Step Gates

| Rule | Effect |
|---|---|
| Internal steps normalize to `{ id, title, status }` records | Handoffs can resume at the exact checkpoint |
| `otm_progress` updates steps by id, title, index, or object | Step status changes are visible as work happens |
| `done` and `skipped` are terminal | Pending, active, or blocked steps prevent parent completion |
| `otm_complete_task` still needs segment evidence | Internal steps alone do not open the stop gate |

When a task has no explicit internal steps, OTM creates category-aware defaults
for implementation, docs/review, validation, install/setup, and final-summary
work. Fallback-planner tasks keep their own actionable steps.

### Hooks And Completion

| Area | Behavior |
|---|---|
| MCP results | Markdown/plain-text first; full JSON remains available through `otm://current` |
| Passive hooks | Touch route state only when the current Codex session is identifiable |
| Duplicate installs | Cross-process invocation claims suppress duplicate global/workspace hook output |
| Evidence tracking | Defaults to file edits, validation/build commands, failures, and explicit OTM checkpoints |
| Opt-ins | `OTM_RECORD_PRE_TOOL=1`, `OTM_TRACK_MCP_EVIDENCE=1`, `OTM_STOP_AUTO_FINALIZE=1`, `OTM_CLAIM_LEGACY_ROUTE=1`; project-instruction sync additionally requires both `OTM_AUTO_SYNC_AGENTS=1` and `OTM_TRUSTED_INSTALLATION=1` |
| Hook timeouts | SessionStart 15s, UserPromptSubmit 12s, PreToolUse 8s, PostToolUse 12s, Pre/PostCompact 15s, Stop 45s |

Normal closeout is model-visible: run `otm_audit_stop`, call
`otm_finalize_turn`, show the returned Markdown summary, then call
`otm_clear_current`. The Stop hook blocks incomplete routes and, by default,
also blocks a complete-but-unfinalized route once so the model can show that
summary before clearing state. A host-marked repeated Stop invocation is always
released, and Stop-hook execution failures fail open with a warning. These are
termination safeguards: they prevent an invalid or duplicate hook from burning
tokens indefinitely while explicit `otm_audit_stop` remains the authoritative
completion check.

For a substantive new implementation request, `UserPromptSubmit` creates the
session-scoped OTM route before the model edits files unless
`OTM_AUTO_START_ROUTE=0`. The route planner keeps listed phases as ordered
segments and activates one segment at a time. Completing a task requires its
terminal internal steps plus evidence; completion then atomically activates the
next eligible task. OTM preserves this durable route across pauses and session
reloads. It cannot create Codex platform-native goals because the host does not
expose that capability to MCP servers or hook scripts.

---

## License

MIT
