# 🧭 Overtli Task Manager

**Codex-first task control for serious engineering.**

Overtli Task Manager (OTM) structures AI coding sessions into evidence-backed routes. It enforces a strict, checklist-driven development flow to ensure complete, verified implementations without premature session stops.

---

## Key Capabilities

*   **Route Checklists:** Deconstruct complex goals into discrete segments (`pending` ➔ `active` ➔ `done` / `blocked`).
*   **Evidence Enforcement:** Tasks can only be marked complete once concrete proof (changed files, test results, command outputs) is provided.
*   **Chat Integration:** Renders real-time, user-friendly Markdown progress dashboards directly in your Codex chat.
*   **Persistent Task List:** Keeps a full checked-off task list in both chat Markdown and `current.json.checklist`.
*   **Durable State Cache:** Syncs active routes to `.codex/overtli-task-manager/current.json` and `current.md` without rewriting unchanged files.
*   **Optimized Rendering:** Shows a full checklist at route start and finalization, then compact progress cards during routine work.
*   **Task Normalization:** Keeps one active route segment where possible, blocks manual jumps until the active task is handled, and lets reconciliation intentionally add, merge, reopen, or reorder work.
*   **Lifecycle Hooks:** Intercepts sessions, prompts, tools, and stops to enforce task completion and audit progress.
*   **Workspace Memory:** Keeps a lightweight, high-signal index of project guides (`AGENTS.md`), memory banks, and schemas.

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

> [!NOTE]
> On Windows, the standard path is `%USERPROFILE%\.codex\plugins\overtli-task-manager`.

### 2. Configure Codex
Add the MCP server to your global configuration in `~/.codex/config.toml`:

```toml
[mcp_servers.overtli_task_manager]
command = "node"
args = ["~/.codex/plugins/overtli-task-manager/bin/otm-mcp.mjs"]
enabled = true
tool_timeout_sec = 45
startup_timeout_sec = 20

[mcp_servers.overtli_task_manager.env]
OTM_STORAGE = "auto"
```

> [!TIP]
> On Windows, replace `~/.codex/plugins/` with the absolute path to your `%USERPROFILE%\.codex\plugins\` folder.

### 3. Install in Target Workspace
Initialize OTM in any target repository to patch its `AGENTS.md`, hooks, skills, and `.gitignore`:

```bash
# From target repository root
node ~/.codex/plugins/overtli-task-manager/bin/otm.mjs install
```

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
| `otm_project_review`| Memory | Index high-signal repository context |
| `otm_memory_search` | Memory | Search stored checkpoints and decision records |

### CLI Interface
```bash
otm install [--workspace PATH] [--dry-run] [--with-project-mcp-config]
otm doctor [--workspace PATH]
otm snapshot [--workspace PATH]
otm review-project [--workspace PATH] [--max-files N]
otm clear-current [--workspace PATH] [--delete-files]
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
 └── summaries/ (Historical turn summaries)
```

`current.md` is the persistent chat-friendly checklist. `current.json.checklist`
contains the same full route list in a compact machine-readable form for UIs,
hooks, or follow-on agents that need to show tasks being checked off.

The default render policy is `start_end_delta`:

```text
Route start: full checklist
Routine progress: compact status card
Steering/manual status: full snapshot
Route finalization: full completion summary
```

`current.json` includes render bookkeeping (`renderRevision`,
`lastRenderedMode`, `lastRenderedTaskId`, and `lastRenderedHash`) so UIs and
agents can avoid repeated full-list rendering.

Task ordering is normalized for readability: completed work stays checked off,
the current active segment is shown next, ordinary pending work stays ahead of
validation/documentation, commit/push, and final audit/summary segments. When a
route is steered, `otm_reconcile` can merge related open tasks, add distinct new
tasks, or explicitly reopen completed/dropped/superseded work with
`action: "reopen"` or `reopen: true`. Reopened tasks keep their prior evidence
and record reopening metadata.

OTM enforces sequential handling for manual task changes. Starting or recording
progress on a different task is blocked while another required task is active
unless the switch is performed through reconciliation or explicitly allowed by
the caller. Whenever OTM chooses a current task, it promotes that task to
`active` and demotes other active route segments so the header, table,
`current.json`, and audit state agree.

Each task keeps internal implementation detail in `metadata.internalSteps`.
Those substeps are persisted for the AI and follow-on agents, but they are not
rendered in chat progress tables by default.

MCP tool results are Markdown/plain-text first. Full machine-readable route
state remains available through the `otm://current` resource, while normal tool
responses avoid showing an additional raw JSON block in chat.

For faster hooks, OTM avoids rewriting unchanged state files and uses read-only
snapshots for passive hook checks. Automatic evidence tracking records only
file edits, validation/build commands, failed commands, and explicit OTM
checkpoint calls by default. Set `OTM_RECORD_PRE_TOOL=1` to record pre-tool
observations, or `OTM_TRACK_MCP_EVIDENCE=1` to opt into broad MCP evidence.

Default hook timeouts are capped but not brittle on Windows: SessionStart 15s,
UserPromptSubmit 12s, PreToolUse 8s, PostToolUse 12s, PreCompact/PostCompact
15s, and Stop 45s.

---

## License

MIT
