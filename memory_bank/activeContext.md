# Active Context

## Current objective

Canonical root-session identity, evidence-proven legacy recovery, and one-reply
Stop closeout are installed and verified. The existing Node-native storage
recovery, model-guided three-tier routes, accumulated source contract, and
installed lifecycle retain their verified behavior.

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
- A root `CODEX_THREAD_ID` selects one current route across home, project,
  nested, and registered moved paths. The route's starting workspace remains
  the primary evidence authority; later paths are persisted aliases. A new
  substantive request after finalization rotates to a new route and must not
  reuse completed evidence.
- JSON and SQLite create/rotate the session binding atomically with the route.
  Distinct session IDs never alias; conflicting payload/environment claims fail
  before route access. Explicit foreign-session run IDs remain rejected.
- A unique active legacy route beats unrelated older completed history. A
  completed duplicate is authoritative only when its reviewed source covers
  the active duplicate and goals, full gate/internal/mini-step contracts,
  descendant completion evidence, and summary evidence agree. Acceptance and
  dependency values remain case-sensitive; required/atomic constraints and
  evidence requirements must match. Active model-authored hierarchy requires
  current source review, while unreviewed scaffolds require exact structure.
  Contradictions remain in bounded attention state;
  explicit same-session `otm_reconcile` selection records a reason hash and
  applies normal contract and descendant gates. Read-only inspection cannot
  clear attention.
- Completed canonical Stop reuses a validated saved summary and returns an allow
  response with a bounded reference, without requesting another model turn.
  Missing summaries may be repaired deterministically;
  stale review digests, incomplete descendants, or contradictory saved summaries
  still block Stop. Manual finalization opt-out and repeated-Stop safeguards stay
  unchanged.
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

## 2026-10-02 - Canonical session identity verification

- Verified: root-session bindings resolve one route across home, project,
  nested, explicitly moved, and restarted workspace aliases. A second session
  remains isolated, and established bindings do not rescan legacy history.
- Verified: JSON and SQLite cross-workspace concurrent starts create one route
  and persist both aliases. SQLite binding writes use immediate transactions;
  this fixes the reproduced `SQLITE_BUSY_SNAPSHOT` and stale-alias compare-and-
  swap race.
- Verified: legacy selection uses one-way completed-source coverage plus
  compatible requirements, hierarchy, gate evidence, descendant evidence, and
  summaries. Conflicting completed receipts remain in actionable attention;
  explicit same-session reconciliation records only a bounded reason hash.
- Verified: Stop after an already sent completed summary, fresh auto-finalized
  Stop, and repeated Stop all return host allow responses without another
  summary instruction. Manual-finalization opt-out and real open-gate blocks
  remain covered.
- Verification: six focused manager, hook, concurrency, store-conformance,
  migration, and MCP suites passed 115 tests; syntax, lint, format, and type
  checks passed.
- Independent Luna Max review found one legacy full-contract comparison gap.
  The same xhigh owner corrected it; 11 targeted legacy tests, 5 hook tests,
  and quality guards passed. The same Max child confirmed the correction with
  no supported residual defect. Unaffected broad checks were not repeated.
- Fresh installed production CLI, Stop, and stdio MCP checks resolve the same
  route across home/project/nested aliases. MCP initialization/discovery and
  the real current resource passed with 25 tools and 3 resources. A genuine
  unfinished gate still blocks; the completed-summary allow path is covered.
- Runtime boundary: the fixture MCP stdio process and fresh hook runner passed.
  A long-running Task Manager MCP process imports `manager.mjs` once and may
  need a normal Codex MCP reload to load source changes. No Codex or ODC process
  was stopped here.

## Exact next action

Use a normal Codex MCP reload to refresh an already-running stdio process.
No implementation or validation action remains. Root owns publication on
`codex/full-production-hardening`; Git history and the scoped release packet
are the commit/push authority rather than a self-referencing hash in this file.
