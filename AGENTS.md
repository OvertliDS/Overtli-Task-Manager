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

1. Before implementation, review the complete accumulated user contract and start or reconcile an Overtli Task Manager route.
2. Map work into a model-authored three-tier hierarchy: major outcome gates (`tasks`), substantive explicit or inferred subtasks (`internalSteps`), and concrete mini-steps for each non-atomic subtask. Tag every gate by its actual work type when prompts mix planning, review, research, documentation, implementation, validation, release, operations, or other justified work. Preserve explicit wording, identifiers, order, constraints, and acceptance conditions; the model owns domain interpretation.
3. Never reuse a canned checklist. Treat deterministic planning only as a visible model-review scaffold and reconcile it into outcome-specific structure before implementation.
4. When native goal controls are available, keep one goal covering the whole request active until the OTM stop audit passes or a genuine blocker is recorded.
5. Use the session-scoped snapshot returned by OTM and exact current task, internal-step, and mini-step ids. Record descendant progress as evidence becomes available, and close a gate only after its required descendants and gate evidence are complete.
6. When the user steers, append the new context, re-review the whole accumulated contract, and reconcile before continuing while preserving still-valid state and evidence.
7. Preserve unrelated user work. Complete every affected implementation, integration, validation, and documentation surface required by the request before claiming the gate is done.
8. Prefer thorough completion over shallow progress. Do not introduce placeholder logic, intentionally incomplete code, or unverified assumptions unless the user explicitly requests a scaffold.
9. Keep progress visible after route creation, steering, blockers, validation, and finalization. Before the final response, run the OTM stop audit and continue if required work remains.
10. Let the Stop hook finalize and clear automatically by default. When automatic finalization is disabled, finalize explicitly, show the summary, and clear current state. Use the packaged Overtli Task Manager skill for detailed schemas, recovery, and troubleshooting.

<!-- OVERTLI-TASK-MANAGER:END -->
