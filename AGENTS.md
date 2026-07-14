# AGENTS.md

## Repository expectations

- Use Overtli Task Manager when making non-trivial changes to this repository.
- Keep implementation production-quality and avoid intentionally incomplete logic.
- Run syntax checks or targeted tests when changing JavaScript modules.
- Preserve installer idempotency: do not patch user files outside managed blocks.
- Keep README and skills aligned with actual tool behavior.

<!-- OVERTLI-TASK-MANAGER:BEGIN v1 -->

## Overtli Task Manager protocol

For every non-trivial Codex task in this workspace:

1. Start or reconcile an Overtli Task Manager route before editing files or running implementation commands.
2. When Codex exposes native goal controls, create one goal if this chat has no active goal. Its objective must cover every requested phase and task; keep it active until the OTM stop audit passes. Use the native terminal goal update only after completion or a genuine blocker, never as a progress substitute.
3. Let OTM isolate routes by workspace and Codex session (`CODEX_THREAD_ID`); use the session-scoped `current.json` path returned by OTM tools. The top-level `current.json` is a multi-session index.
4. Show modern Markdown progress snapshots in chat after route creation, steering changes, blocked work, validation, and finalization.
5. Treat tasks as route segments: one active segment at a time unless the user explicitly requests parallel work.
6. Before task-scoped OTM calls, use exact task ids from the latest OTM snapshot or its session-scoped `current.json`; never copy ids from another chat, the workspace index, memory, or prior route state.
7. While working a route segment, mark each internal step complete with `otm_progress` as soon as that step has concrete evidence; do not wait until the end and backfill the internal checklist.
8. Mark a segment done with `otm_complete_task` only after every required internal step is terminal (`done` or intentionally `skipped`) and segment-level evidence exists, such as changed files, command output, test results, document review, or user confirmation.
9. If the user changes direction, reconcile the route immediately instead of continuing from stale assumptions.
10. Before any final response, run the OTM stop audit. If required segments remain open, continue working instead of ending the turn.
11. At completion, let the Stop hook automatically finalize, save the summary, clear active state, and return the saved summary for the final reply. If `OTM_STOP_AUTO_FINALIZE=0`, manually call `otm_finalize_turn`, show its Markdown summary, then call `otm_clear_current`.
12. Prefer thorough completion over shallow progress. Do not introduce placeholder logic, intentionally incomplete code, or unverified assumptions unless the user explicitly requests a scaffold.

<!-- OVERTLI-TASK-MANAGER:END -->
