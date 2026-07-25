# Active Context

## Current objective

Overtli Task Manager's Node-native storage recovery, model-guided three-tier
route interpretation, mixed-intent gates, accumulated source contract, and
installed lifecycle are production-hardened, released, and globally deployed.

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
- The scoped release is pushed on `codex/full-production-hardening`. The global
  plugin clone is fast-forwarded to the release, and its dependency tree loads
  `better-sqlite3@11.10.0` with SQLite 3.49.2 under Node 22.23.1 ABI 127.
- Two consecutive global installs produced no second-run changes across the 10
  tracked managed files. Global MCP configuration, all seven hook events, all
  four skills, and global/workspace managed AGENTS blocks match the release.
- A disposable installed-copy smoke exercised MCP stdio with SQLite, mixed
  review/documentation gates, two internal subtasks, two nested mini-steps,
  accumulated source context, recursive evidence gates, audit, summary,
  finalization, and clearing. Installed prompt and Stop hooks also auto-started
  and stop-gated an isolated route as designed.

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

No implementation action remains. Restart or reload long-running Codex
workspaces so their already-running MCP process releases the retired native
module mapping and reconnects to the verified installed release.
