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
9. Inspect the canonical source-context digest, `contractReview`, route gates, internal subtasks, and nested mini-steps. A fallback scaffold or unreconciled source revision must remain non-completable.
10. Confirm explicit outline identifiers were preserved and that inferred hierarchy is marked model-derived. Verify required descendants and their evidence before diagnosing a gate as stuck.
11. Inspect each gate's `workType` and the route's `routeIntent`. A mixed prompt must remain mixed; review/planning/documentation gates must not be diagnosed as incomplete merely because they did not perform unrequested implementation.
12. Use `OTM_CLAIM_LEGACY_ROUTE=1` only for an intentional one-time legacy migration.
13. Inspect the native SQLite probe result. In `OTM_STORAGE=auto`, a genuine Node ABI mismatch may trigger one bounded locked rebuild and then fall back to JSON without deleting the SQLite database. In explicit `sqlite` mode, failure must remain actionable and fail closed.
14. Check Node version/ABI, resolved `better-sqlite3` binding, rebuild eligibility/diagnostic, and the installed plugin copy separately from source.
15. Report exact repair actions and avoid deleting databases, unrelated project configuration, session history, or active scratch evidence.
