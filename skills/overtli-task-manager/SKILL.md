---
name: overtli-task-manager
description: Use for non-trivial Codex work that needs route-based task planning, step-by-step chat progress, current.json state, evidence-backed completion, steering reconciliation, stop audits, checkpoint summaries, and project memory.
---

# Overtli Task Manager

Use this skill when the user asks Codex to build, fix, refactor, research, review, install, package, debug, or continue a multi-step task.

## Route protocol

1. Before implementation work, thoroughly analyze the full user request and all context available to the model: inline chat text, attached files, screenshots/images you can inspect, OCR/descriptions, IDE context, and prior steering in the turn.
2. Call `otm_start` for a new task or `otm_reconcile` for steering/continuation. Pass the current repository root as `workspaceRoot` whenever it is known.
3. Build route segments from the main current-scope phases, steps, issues, problems, and deliverables you identify. Do not collapse distinct requested work into a vague task like `fix all issues`.
4. Pass model-derived route segments in the `tasks` array whenever possible, with concise titles plus `internalSteps` or `metadata.internalSteps` for explicit, inferred, researched, and discovered subwork.
5. If the user is asking for a phase plan, roadmap, review, or documentation rather than implementation now, make the route reflect that planning/documentation task instead of converting it into implementation work.
6. Show the returned Markdown snapshot in chat.
7. Keep one active route segment whenever possible by calling `otm_start_task` before focused work.
8. Before calling task-scoped OTM tools, use exact task ids from the latest OTM snapshot or `.codex/overtli-task-manager/current.json`. Never guess ids from titles, memory, or prior route state.
9. Use `otm_progress` for meaningful checkpoints: route created, task started, each internal step completed, steering change, blocker, validation start, validation result, and finalization.
10. Mark internal steps complete as soon as their evidence exists. Do not finish the project and then backfill the internal checklist.
11. Complete tasks with `otm_complete_task` only when evidence is concrete and every required internal step is terminal (`done` or intentionally `skipped`): files changed, commands run, tests passed, docs reviewed, or user-confirmed decision.
12. If the user changes direction, immediately call `otm_reconcile`; drop or supersede stale segments instead of leaving contradictory work open.
13. Before final response, call `otm_audit_stop`.
14. If the audit says stop is blocked, keep working on the listed required segments.
15. When the audit passes, call `otm_finalize_turn`, show its Markdown summary to the user, then call `otm_clear_current`.

## Quality bar

- Aim for complete, production-quality work.
- Do not introduce intentionally incomplete logic, placeholder behavior, or hand-wavy validation unless the user explicitly requests a scaffold.
- Check for errors and regressions related to each completed segment.
- Prefer concise modern Markdown status updates over noisy logs.
- Use project memory only for concise continuation context, decisions, checkpoints, and project awareness. Do not turn it into a full source-code index.

## Continuations

When the user says continue, resume, checkpoint, or adds to the same workstream:

1. Search memory with `otm_memory_search` for the new prompt and the active route goal.
2. Call `otm_reconcile` with mode `continue` or `append`.
3. Keep prior completed evidence intact.
4. Add new required segments when the user expands scope.
5. Supersede stale segments when the user redirects scope.
