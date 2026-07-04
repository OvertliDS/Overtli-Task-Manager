# Architecture

Overtli Task Manager is built around a shared core library used by both MCP tools and Codex hooks.

```text
Codex MCP tools ─┐
                 ├─ OTM core state machine ── storage ── current.json/current.md
Codex hooks    ──┘
```

## State

The durable store tracks runs, tasks, events, summaries, and cache entries. SQLite is preferred; JSON is a fallback for machines that cannot install native dependencies.

## Workspace files

Workspace state is intentionally small and inspectable:

```text
.codex/overtli-task-manager/current.json
.codex/overtli-task-manager/current.md
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
`cache/scratch/` and referenced from evidence with a short path. Workflow
cleanup removes scratch dumps after roughly 30 minutes; atomic temp cleanup uses
a shorter concurrency guard so active writes are not deleted.
At route completion, `otm_clear_current` runs immediate OTM-owned temp/scratch
cleanup. `otm_cleanup_workspace` and `otm cleanup` expose the same cleanup path
for explicit maintenance.

## Project memory

Project memory is not a full RAG index. It is a lightweight, project-specific cache that prefers overview files and durable summaries.

## Hooks

The Stop hook is the enforcement gate. If required route segments remain open, it returns a block decision and Codex continues the turn with the remaining work as the continuation prompt.
