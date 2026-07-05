<!-- OVERTLI-TASK-MANAGER:BEGIN v1 -->
## Overtli Task Manager protocol

For every non-trivial Codex task in this workspace:

1. Start or reconcile an Overtli Task Manager route before editing files or running implementation commands.
2. Keep `.codex/overtli-task-manager/current.json` current through the OTM MCP tools.
3. Show modern Markdown progress snapshots in chat after route creation, steering changes, blocked work, validation, and finalization.
4. Treat tasks as route segments: one active segment at a time unless the user explicitly requests parallel work.
5. Before task-scoped OTM calls, use exact task ids from the latest OTM snapshot/current.json; never guess ids from titles, memory, or prior route state.
6. While working a route segment, mark each internal step complete with `otm_progress` as soon as that step has concrete evidence; do not wait until the end and backfill the internal checklist.
7. Mark a segment done with `otm_complete_task` only after every required internal step is terminal (`done` or intentionally `skipped`) and segment-level evidence exists, such as changed files, command output, test results, document review, or user confirmation.
8. If the user changes direction, reconcile the route immediately instead of continuing from stale assumptions.
9. Before any final response, run the OTM stop audit. If required segments remain open, continue working instead of ending the turn.
10. At completion, call `otm_finalize_turn`, show its Markdown summary to the user, then call `otm_clear_current`; the Stop hook is only a fallback guard, not the normal final-summary path.
11. Prefer thorough completion over shallow progress. Do not introduce placeholder logic, intentionally incomplete code, or unverified assumptions unless the user explicitly requests a scaffold.

<!-- OVERTLI-TASK-MANAGER:END -->
