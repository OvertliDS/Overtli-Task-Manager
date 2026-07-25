# Changelog

## 0.2.0 - Unreleased

### Model-guided route decomposition

- Route tasks are completion gates for major outcomes, internal subtasks
  preserve explicit or model-inferred substantive children, and non-atomic
  subtasks own nested concrete mini-steps.
- Recursive lifecycle checks require current model review, terminal required
  descendants, descendant evidence, dependency satisfaction, and gate evidence.
  Atomic subtasks require an explicit rationale.
- Deterministic planning no longer emits canned category checklists. It retains
  one visible, non-completable `needsModelReview` scaffold when semantic model
  reconciliation is required.
- Inline/pasted text, structured context, attachment/OCR content, and visual
  descriptions enter one bounded redacted source contract with provenance,
  revision history, and an accumulated digest.
- Steering appends source context and requires whole-contract reconciliation
  while preserving valid identifiers, ordering, evidence, timestamps, and
  supersession history.
- Canonical session snapshots, JSON/SQLite storage, summaries, history,
  checkpoint memory, restart recovery, and export/import preserve the hierarchy
  and source contract; the workspace index remains a lightweight pointer.
- Every gate now carries a model-interpreted `workType`; routes aggregate those
  labels into durable single/mixed intent without converting planning, review,
  research, or documentation gates into implementation. Snapshots, Markdown,
  summaries, MCP schemas, hooks, skills, examples, and installer guidance
  preserve the classification and outcome-appropriate evidence contract.

### Security and lifecycle hardening

- Canonical workspace/path validation rejects traversal and root escapes.
- Route creation is atomic across run, tasks, and initial event, with an active workspace/session uniqueness invariant.
- Public route inputs cannot initialize terminal task states, bypass evidence, or mutate cross-run tasks.
- SQLite migrations use `PRAGMA user_version`, recoverable pre-migration backups, and strict JSON-column parsing.
- Corrupt JSON state is quarantined and reported instead of reset.
- Hook evidence and scratch command capture redact common credential patterns.
- Workspace installation is preflighted and dry-run is side-effect free.
- Dependency audit findings are remediated: ESLint 10 removes the vulnerable
  `brace-expansion` chain, patched `fast-uri` is locked, and
  `@hono/node-server` 2.0.5+ is enforced for the MCP SDK's compatible request
  listener API.

### Compatibility

- Node.js 20.10+ remains supported.
- Native SQLite availability now includes a real binding probe. ABI mismatches trigger one guarded automatic rebuild before `auto` falls back to JSON; explicit SQLite remains fail-closed with actionable diagnostics.
- Existing SQLite v1-v3 stores are migrated through ordered schema v4
  migrations on open. Schema v4 rebuilds legacy child tables with real
  cascading foreign keys, including stores whose old metadata incorrectly
  claimed a current version. A
  `state.sqlite.pre-migration-v<previous-version>-*.bak` recovery copy is
  retained before each upgrade or corrective rebuild.
- JSON remains supported as a validated fallback store.
- Read-only doctor index checks recognize current flattened session snapshots
  while retaining compatibility with legacy nested snapshots, eliminating a
  false active-session-count warning.
