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
```

## Project memory

Project memory is not a full RAG index. It is a lightweight, project-specific cache that prefers overview files and durable summaries.

## Hooks

The Stop hook is the enforcement gate. If required route segments remain open, it returns a block decision and Codex continues the turn with the remaining work as the continuation prompt.
