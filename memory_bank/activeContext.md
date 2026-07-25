# Active Context

## Current objective

Production-harden Overtli Task Manager for Node-native storage recovery and
model-guided route interpretation, complete all validation, push the scoped
branch, and reinstall/verify the global MCP, hooks, skills, and native runtime.

## Preserved user contract

- `OTM_STORAGE=auto` must attempt one bounded concurrency-safe repair only for a
  genuine `better-sqlite3` Node ABI mismatch, then continue through JSON without
  deleting or overwriting the SQLite database. Explicit `sqlite` remains
  fail-closed and actionable.
- The model, not OTM, owns domain interpretation. OTM provides a structural
  template and lifecycle gates; it must not generate identical canned steps.
- Three tiers are required:
  1. route segment/completion gate for a major outcome (for example Phase 3);
  2. explicit or model-inferred substantive internal subtasks (for example
     Phase 3.1/3.2);
  3. concrete mini-steps required to finish each non-atomic internal subtask.
- Explicit identifiers, wording, order, constraints, and acceptance conditions
  remain authoritative. A genuinely atomic internal subtask needs a rationale.
- Prompts without phase labels still receive model-authored bounded outcome
  gates/subtasks/mini-steps. Deterministic fallback is only a visible
  `needsModelReview` scaffold.
- Inline/pasted text, structured prompt context, attachment/OCR text,
  screenshot/image descriptions, and later steering form one accumulated
  bounded source contract. Reconciliation re-reviews the whole contract without
  losing valid IDs, evidence, order, or supersession history.
- Canonical session snapshots, JSON/SQLite, restart, summaries, history,
  checkpoint memory, cache/scratch references, and export/import preserve the
  hierarchy/context. Top-level `current.json` stays a lightweight session index.
- Managed AGENTS content, MCP schemas/descriptions, hooks, four skills, examples,
  documentation, installer output, package contents, and the global copy must
  agree.
- The supplied Avatar Studio attachment is a hierarchy fixture only. No Avatar
  Studio files, runtime, Git state, or documentation may be modified.
- Preserve the pre-existing user deletion of `.codex-plugin/plugin.json`; do
  not restore, stage, commit, or push it.

## Evidence-backed status

### Verified

- Root cause: source and installed `better-sqlite3` binaries targeted a
  different Node module ABI than active Node 22.23.1 (ABI 127).
- Native probing, ABI-only bounded repair, rebuild locking/npm resolution,
  `auto` JSON fallback, explicit-SQLite failure, read-only doctor reporting,
  and targeted runtime tests are implemented.
- Explicit Phase -> subphase -> mini-step parsing, contextual numbered children,
  visible synthesized ancestors, provenance, fallback replacement, recursive
  progress/gates, atomic rationale, descendant evidence, summary rendering, and
  nested MCP schemas are implemented.
- Bounded redacted source-context entries and revision digests survive steering,
  JSON restart, canonical snapshots, hierarchy-aware summaries, checkpoint
  memory, export/import, and lightweight workspace indexing.
- The 1,868-line Avatar Studio prompt was reviewed only as a fixture: its 35
  Phase 0-34 headings are gate candidates; global constraints/Definition of
  Done/stop/report clauses remain cross-cutting context; representative phase
  bodies map to internal subtasks and concrete mini-steps by semantic role.
- Targeted planner, source-context, manager, hook, and syntax suites pass after
  the hierarchy/context work.
- Full source validation passes: 173 tests with zero failures/skips, 93.73%
  overall coverage, 91.54% SQLite-store line coverage, lint, format, type,
  syntax (66 modules), CI, whitespace, and MCP Streamable HTTP compatibility.
- `npm audit` reports zero vulnerabilities after the ESLint 10 toolchain
  upgrade, patched transitive packages, and a compatible
  `@hono/node-server` 2.0.5+ override.
- Package dry-run contains 85 expected files, including source-context and
  SQLite runtime modules/tests, hooks, and four skills; the user-deleted plugin
  manifest remains excluded.

### In progress

- Review and stage only task-owned source, tests, package metadata,
  documentation, skills, and installer changes.

### Pending

- Stage only task-owned files, excluding `.codex-plugin/plugin.json`; commit and
  push `codex/full-production-hardening`; verify upstream parity.
- Fast-forward `C:\Users\antju\.codex\plugins\overtli-task-manager`, install
  active-ABI dependencies, run `install-global`, and verify configured MCP,
  seven hook events, four skills, managed AGENTS behavior, native SQLite/JSON
  fallback, and an installed disposable lifecycle.

## Important files

- `src/storage/sqlite-store.mjs`, `src/storage/store.mjs`,
  `src/cli/doctor.mjs`: native runtime probe/repair/fallback/diagnostics.
- `src/core/planner.mjs`, `src/core/source-context.mjs`,
  `src/core/manager.mjs`, `src/core/renderer.mjs`: interpretation, accumulated
  context, recursive lifecycle, persistence projections, and summaries.
- `src/mcp/schemas.mjs`, `src/mcp/tools.mjs`, `src/hooks/runner.mjs`,
  `src/install/agent-block.mjs`: model-facing and installed contract.
- `tests/sqlite-runtime.test.mjs`, `tests/planner.test.mjs`,
  `tests/source-context.test.mjs`, `tests/manager.test.mjs`: primary new
  regressions.

## Exact next action

Run the final staged-diff/package audit while explicitly excluding the
user-owned plugin-manifest deletion, then commit and push the verified branch.
