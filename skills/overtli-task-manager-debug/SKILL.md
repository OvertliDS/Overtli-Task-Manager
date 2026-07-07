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
6. If Stop hook loops, verify the hook payload/environment resolves the current session and compare it with the session-scoped state path. Never use an unrelated legacy route as a substitute.
7. Check for both global and workspace OTM hooks. Duplicate installs are supported, but identical host invocations must be suppressed by the hook claim under `cache/tmp/hook-invocations/`.
8. Confirm repeated Stop feedback carries `stop_hook_active`; OTM must release that invocation. Stop-hook errors must return `continue`, not another block.
9. Inspect remaining required segments and either complete, block with evidence, drop, or supersede them according to user intent.
10. Use `OTM_CLAIM_LEGACY_ROUTE=1` only for an intentional one-time legacy migration.
11. If SQLite is unavailable, verify whether OTM is using the JSON fallback intentionally or reinstall optional dependencies.
12. Report exact repair actions and avoid deleting unrelated project configuration.
