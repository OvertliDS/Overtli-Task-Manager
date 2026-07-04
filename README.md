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
| `otm_cleanup_workspace` | Completion | Clean OTM-owned temp and scratch artifacts |
| `otm_prune_history` | Completion | Prune durable run/task/event/summary/cache history older than retention |
| `otm_project_review`| Memory | Index high-signal repository context |
| `otm_memory_search` | Memory | Search stored checkpoints and decision records |

### CLI Interface
```bash
otm install [--workspace PATH] [--dry-run] [--with-project-mcp-config]
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

`current.md` is the persistent chat-friendly checklist. `current.json.checklist`
contains the same full route list in a compact machine-readable form for UIs,
hooks, or follow-on agents that need to show tasks being checked off.
Current-state writes stage temporary files under `cache/tmp` and clean stale
OTM-owned `current.json.*.tmp` / `current.md.*.tmp` files from older versions,
so the workspace state folder stays inspectable.
Long raw tool inputs are written to `cache/scratch` and referenced from route
evidence with a short pointer, keeping `current.md` and turn summaries readable.
Workflow cleanup treats scratch files as short-lived and removes stale scratch
dumps after roughly 30 minutes.
`otm_clear_current` also runs immediate OTM-owned temp/scratch cleanup at route
completion, and `otm_cleanup_workspace` exposes the same cleanup as an explicit
tool/CLI command.

Durable history cleanup is separate from workspace temp cleanup. `otm_clear_current`
also runs a best-effort prune of inactive history older than 7 days. Use
`otm_prune_history` or `otm prune-history` to run it explicitly, with
`--dry-run` for an audit-only report. History pruning preserves active, blocked,
and paused routes even when they are older than the cutoff, then removes old
inactive runs plus their tasks, events, summaries, and expired/old cache entries.

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

The model should analyze the full user request before calling `otm_start` or
`otm_reconcile`: inline chat text, attached files, screenshots/images it can
inspect, OCR or descriptions, IDE context, and steering within the turn. The
model should pass a `tasks` array that maps the main current-scope phases,
steps, issues, problems, and deliverables to separate route segments, with
`internalSteps` or `metadata.internalSteps` for explicit, inferred, researched,
and discovered subwork. OTM persists and normalizes those segments; it does not
perform model-level visual or semantic inference on its own.

When `otm_start` receives only a goal or prompt, a deterministic fallback
planner acts as a safety net. It looks for obvious explicit phases, steps,
issue lists, problem lists, and sequenced deliverables so they are not collapsed
into one broad "fix everything" task. If the prompt is asking for a plan, spec,
or documentation for later work, fallback segments stay
planning/documentation-oriented rather than becoming implementation tasks.

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
String inputs remain accepted, but OTM normalizes them into small records with
`id`, `title`, and `status` so `current.json` can show which internal checkpoint
is pending, active, done, blocked, or skipped after compaction or handoff.
`otm_progress` can update one internal step by id, title, index, or object.
Internal steps are prerequisites for the parent route segment: a route gate
cannot be completed while any internal step is pending, active, or blocked.
`done` and `skipped` are terminal internal states. Internal steps still do not
complete the parent route segment or open the stop gate by themselves; the model
must also call `otm_complete_task` with concrete evidence when a top-level route
checkpoint/gate is actually complete.

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
