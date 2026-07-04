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
2. Keep `.codex/overtli-task-manager/current.json` current through the OTM MCP tools.
3. Show modern Markdown progress snapshots in chat after route creation, steering changes, blocked work, validation, and finalization.
4. Treat tasks as route segments: one active segment at a time unless the user explicitly requests parallel work.
5. Mark a segment done only after concrete evidence exists, such as changed files, command output, test results, document review, or user confirmation.
6. If the user changes direction, reconcile the route immediately instead of continuing from stale assumptions.
7. Before any final response, run the OTM stop audit. If required segments remain open, continue working instead of ending the turn.
8. At completion, write a turn summary, save useful checkpoint memory, clear the active route state, and mention the summary location.
9. Prefer thorough completion over shallow progress. Do not introduce placeholder logic, intentionally incomplete code, or unverified assumptions unless the user explicitly requests a scaffold.

<!-- OVERTLI-TASK-MANAGER:END -->
