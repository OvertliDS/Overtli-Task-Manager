---
name: overtli-task-manager-memory
description: Use for project-specific lightweight memory: refreshing project overview cache, searching checkpoint summaries, storing durable decisions, pruning stale context, and continuing similar prior routes without full source scans.
---

# Overtli Task Manager memory

Use this skill when Codex needs lightweight project context or continuation support.

## What to cache

- Turn summaries after completed routes.
- Durable decisions and constraints.
- Project overview synthesized from README, AGENTS.md, docs, memory banks, manifests, PRDs, GDDs, and architecture files.
- Checkpoints that help future Codex runs resume accurately.

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
5. Keep memory concise and project-specific.
