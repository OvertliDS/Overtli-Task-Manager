---
name: overtli-task-manager-debug
description: Diagnose Overtli Task Manager problems including stale current.json, missing hooks, duplicate AGENTS.md markers, missing repo skills, storage fallback, project memory issues, or Stop hook continuation loops.
---

# Debug Overtli Task Manager

1. Run `otm_doctor`.
2. Inspect `.codex/overtli-task-manager/current.json` as the workspace session index, then inspect the current chat's session-scoped state path under `.codex/overtli-task-manager/sessions/` as reported by `otm_snapshot` or `otm_doctor`.
3. Check that the repository contains a single OTM AGENTS block.
4. Check `.codex/hooks.json` for one OTM command per supported event.
5. Check `.agents/skills` for the OTM skills.
6. If Stop hook loops, inspect remaining required segments and either complete, block with evidence, drop, or supersede them according to user intent.
7. If SQLite is unavailable, verify whether OTM is using the JSON fallback intentionally or reinstall optional dependencies.
8. Report exact repair actions and avoid deleting unrelated project configuration.
