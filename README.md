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
*   **Persistent Task List:** Keeps a full checked-off task list in both chat Markdown and `current.json.checklist`.
*   **Durable State Cache:** Syncs active routes to `.codex/overtli-task-manager/current.json` and `current.md` without rewriting unchanged files.
*   **Optimized Rendering:** Shows a full checklist at route start and finalization, then compact progress cards during routine work.
*   **Task Normalization:** Keeps one active route segment where possible, blocks manual jumps until the active task is handled, and lets reconciliation intentionally add, merge, reopen, or reorder work.
*   **Internal Step Gates:** Keeps each route segment honest by requiring internal steps to be checked off as work happens before the parent segment can be completed.
*   **Lifecycle Hooks:** Intercepts sessions, prompts, tools, and stops to enforce task completion and audit progress.
*   **Workspace Memory:** Keeps a lightweight, high-signal index of project guides (`AGENTS.md`), memory banks, and schemas.
*   **Managed Instruction Sync:** Detects the enclosing Git workspace and creates or refreshes only OTM's marked `AGENTS.md` block at session start.

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

When run from that standard plugin path, `npm install` automatically merges OTM hooks into `~/.codex/hooks.json` and refreshes OTM skills under `~/.codex/skills`. Existing global hooks are backed up and unrelated entries are preserved. Development checkouts and CI skip global changes; set `OTM_AUTO_INSTALL_GLOBAL=0` to opt out or `OTM_AUTO_INSTALL_GLOBAL=1` to allow a custom plugin path.

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

When the plugin's `SessionStart` hook is active, OTM also creates or refreshes its managed block in the enclosing Git workspace automatically. Existing content outside the markers is preserved, incomplete marker pairs are reported without being overwritten, and `OTM_AUTO_SYNC_AGENTS=0` disables this synchronization. Nested package manifests do not shadow the enclosing Git root.

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
otm doctor [--workspace PATH]
otm snapshot [--workspace PATH]
otm review-project [--workspace PATH] [--max-files N]
otm clear-current [--workspace PATH] [--delete-files]
otm cleanup [--workspace PATH] [--min-age-ms N] [--scratch-max-age-ms N]
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
 ├── current.json / current.md (Active route, checklist, and checkpoint status)
 ├── cache/ (Lightweight context and review caches)
 │   ├── tmp/ (Atomic write staging; stale OTM temp files are cleaned automatically)
 │   └── scratch/ (Raw hook/tool payloads kept out of user-facing Markdown)
 └── summaries/ (Historical turn summaries)
```

### State Files

| File / Folder | Purpose |
|---|---|
| `current.md` | Chat-friendly route checklist for humans and follow-on agents |
| `current.json.checklist` | Compact machine-readable checklist for UIs and hooks |
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

`current.json` tracks render metadata (`renderRevision`, `lastRenderedMode`,
`lastRenderedTaskId`, `lastRenderedHash`) so agents and UIs can avoid repeating
the full checklist unnecessarily.

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
| Passive hooks | Use read-only snapshots and avoid unchanged state rewrites |
| Evidence tracking | Defaults to file edits, validation/build commands, failures, and explicit OTM checkpoints |
| Opt-ins | `OTM_RECORD_PRE_TOOL=1`, `OTM_TRACK_MCP_EVIDENCE=1`, `OTM_STOP_AUTO_FINALIZE=1` |
| Hook timeouts | SessionStart 15s, UserPromptSubmit 12s, PreToolUse 8s, PostToolUse 12s, Pre/PostCompact 15s, Stop 45s |

Normal closeout is model-visible: run `otm_audit_stop`, call
`otm_finalize_turn`, show the returned Markdown summary, then call
`otm_clear_current`. The Stop hook blocks incomplete routes and, by default,
also blocks a complete-but-unfinalized route once so the model can show that
summary before clearing state.

---

## License

MIT
