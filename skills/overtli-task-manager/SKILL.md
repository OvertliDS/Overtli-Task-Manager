---
name: overtli-task-manager
description: Use for non-trivial Codex work that needs route-based task planning, step-by-step chat progress, current.json state, evidence-backed completion, steering reconciliation, stop audits, checkpoint summaries, and project memory.
---

# Overtli Task Manager

Use this skill when the user asks Codex to build, fix, refactor, research, review, install, package, debug, or continue a multi-step task.

## Route protocol

1. Before implementation, review the complete accumulated contract: inline/pasted chat, structured context, attached/OCR text, screenshot/image descriptions, explicit identifiers and ordering, constraints, acceptance conditions, and later steering.
2. Call `otm_start` for a new task or `otm_reconcile` for steering/continuation. Pass the current repository root as `workspaceRoot`.
3. Supply a model-authored three-tier route:
   - Tier 1 `tasks`: bounded completion gates for major outcomes, such as Phase 3. Set each gate's model-interpreted `workType`; a prompt may mix planning, review, research, documentation, implementation, validation, release, deployment, operations, or justified custom work.
   - Tier 2 `internalSteps`: substantive explicit children such as Phase 3.1/3.2, or the smallest complete outcome-specific subtasks inferred when none are stated.
   - Tier 3 `miniSteps`: concrete verifiable actions needed to complete each non-atomic internal subtask.
4. Preserve explicit wording, identifiers, and order. Mark inferred structure as model-derived. Set `atomic=true` only for a genuinely atomic subtask and include `atomicRationale`.
5. OTM supplies the structural and lifecycle contract; the model owns all domain content. Never give every segment the same canned checklist. A deterministic `needsModelReview` scaffold must be replaced through reconciliation before implementation.
6. Attach concise outcomes/gists, dependencies, source references/provenance, acceptance conditions, and evidence expectations where useful. Do not collapse distinct work into a vague gate such as `fix all issues`.
7. Interpret intent per gate, not once for the whole prompt. Preserve a mixed route when the request combines planning/review/documentation and implementation. Planning, review, research, and documentation gates use evidence appropriate to those outcomes without implying unrequested code changes; implementation gates still require implementation, integration, validation, and synchronized affected documentation.
8. Show the returned Markdown snapshot in chat and keep one active route gate whenever possible.
9. OTM scopes routes by workspace and `CODEX_THREAD_ID` (or explicit `sessionId`). Use exact task, internal-step, and mini-step ids from the latest snapshot or session-scoped `current.json`. The top-level `current.json` is only a workspace session index.
10. Use `otm_progress` as evidence arrives. Mark mini-steps and their parent internal subtasks terminal promptly; do not backfill them at the end.
11. Complete a gate with `otm_complete_task` only after the accumulated contract is reviewed, all required descendants are terminal with required evidence, and concrete gate evidence exists.
12. When steering arrives, append the new typed/attached/visual context, re-review the whole accumulated contract, and call `otm_reconcile`. Preserve valid IDs, evidence, order, constraints, and supersession history; reopen only invalidated work.
13. Before final response, call `otm_audit_stop`. If it is blocked, continue the listed work.
14. When the audit passes, send the final response. By default the Stop hook finalizes, saves the hierarchy-aware summary/checkpoint memory, and clears active state. If `OTM_STOP_AUTO_FINALIZE=0`, call `otm_finalize_turn`, show its Markdown summary, then call `otm_clear_current`.

OTM hooks enforce only a resolved Codex session. Never substitute the
workspace index or a legacy unscoped route when a hook lacks session identity.
Duplicate global/workspace hook invocations and host-marked repeated Stop calls
are termination safeguards; do not counteract their silent allow response by
manually repeating stale hook feedback.

## Quality bar

- Aim for complete, production-quality work.
- Do not introduce intentionally incomplete logic, placeholder behavior, or hand-wavy validation unless the user explicitly requests a scaffold.
- Check for errors and regressions related to each completed segment.
- Prefer concise modern Markdown status updates over noisy logs.
- Use Overtli Task Manager project memory only for concise continuation context, decisions, checkpoints, and project awareness. Do not turn it into a full source-code index.

## Continuations

When the user says continue, resume, checkpoint, or adds to the same workstream:

1. Search memory with `otm_memory_search` for the new prompt and the active route goal.
2. Read the canonical session snapshot, including its accumulated source-context digest and hierarchy.
3. Call `otm_reconcile` with mode `continue` or `append` and a complete reviewed three-tier route.
4. Keep prior completed evidence and still-valid descendant state intact.
5. Add new required gates/subtasks/mini-steps when scope expands; supersede stale structure when scope redirects.
