---
name: overtli-task-manager-memory
description: Use for project-specific lightweight memory: refreshing project overview cache, searching checkpoint summaries, storing durable decisions, pruning stale context, and continuing similar prior routes without full source scans.
---

# Overtli Task Manager memory

Use this skill when Codex needs lightweight project context or continuation support. This does not replace reviewing current workspace source files, context, memory_bank files, manifests, PRDs, GDDs, architecture files, and other documentation in the codebase/workspace. It is a project-specific cache for concise summaries, decisions, and checkpoints that help resume similar work without full source scans.

## What to cache

- Turn summaries after completed routes.
- Durable decisions and constraints.
- Project overview synthesized from README, AGENTS.md, docs, memory banks, manifests, PRDs, GDDs, and architecture files.
- Checkpoints that help future Codex runs resume accurately.
- Hierarchy-aware turn summaries that retain the accumulated source-context
  digest/revision summary, route gates, internal subtasks, mini-steps, evidence,
  per-gate work types, mixed route intent, and supersession state.

## What not to cache

- Full source files.
- Secrets or credentials.
- Large generated logs.
- Temporary guesses that were not validated.

## Workflow

1. On project initialization or manual request, call `otm_project_review`.
2. Before resuming similar work, call `otm_memory_search`.
3. Store durable decisions with `otm_memory_upsert`.
4. Remove stale entries with `otm_memory_delete` when facts change.
5. Use the session-scoped canonical snapshot for active route truth. The
   workspace `current.json` index is only a lightweight pointer and must not be
   cached or interpreted as the active hierarchy.
6. Keep searchable memory concise and project-specific; full bounded source
   context remains in canonical route/summary history rather than being copied
   into many duplicate cache entries.
