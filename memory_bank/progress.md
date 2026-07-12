# Progress

## 2026-07-11 - Focused test-suite extraction and destructive store conformance

- [x] Verified: planner, MCP protocol, SQLite migrations, and security/path/corruption cases now run from dedicated focused test modules rather than duplicate copies in the broad manager integration file.
- [x] Verified: CLI help/version strict parsing, raw read-only doctor diagnostics, and dry-run non-mutation checks now run in `tests/cli.test.mjs` rather than duplicate copies in the broad manager integration file.

## 2026-07-11 - Required SQLite and package export smoke gate

- [x] Verified: `better-sqlite3` moved from `optionalDependencies` to `dependencies`; CI uses `npm ci` and each SQLite lane asserts the native backend is available instead of skipping or returning early.
- [x] Verified: a self-reference package-export smoke test imports the root, MCP, and hooks entry points through `@overtli/task-manager` rather than source-relative paths.
- Verification: clean `npm ci`, `npm ls better-sqlite3 --depth=0`, package smoke tests, SQLite lifecycle/pruning tests, syntax, and diff checks passed.

## 2026-07-11 - Multi-process lifecycle mutation races

- [x] Verified: dedicated child-process races now cover JSON-backed progress, reconciliation, completion, and current-state clearing. One operation commits the expected route revision/state and all competing results are typed conflicts or safe invalid-transition outcomes.
- Verification: `tests/concurrency.test.mjs` passed with the other focused suites; syntax and diff checks passed. Full coverage must be rerun after this addition.

## 2026-07-11 - Renderer privacy and no-op golden coverage

- [x] Verified: Markdown rendering escapes untrusted goal/task/internal-step/update/summary values outside table cells as well as within them.
- [x] Verified: focused renderer tests pin planned checklist ordering, lifecycle-derived completion deltas, and unchanged current-file write suppression.
- Verification: renderer suite, syntax, and diff checks passed. Full coverage must be rerun after this addition.

## 2026-07-11 - Project review eligibility-before-limit repair

- [x] Verified: project review rejects binary and oversized documents before applying `maxFiles`, so unusable candidates cannot consume eligible source slots; it checks the configured byte cap before reading a file.
- [x] Verified: focused project-review tests cover deterministic truncation diagnostics, symlink containment, and selection of an eligible document after earlier binary/oversized candidates.
- Verification: project-review suite, syntax, and diff checks passed. Full coverage must be rerun after this addition.

## 2026-07-11 - Full cross-phase verification checkpoint

- [x] Verified: full suite passes 114 tests with no skips; SQLite is required and loaded.
- [x] Verified: coverage is 91.31% overall; manager 93.81%, JSON store 97.06%, SQLite store 95.39%, and validation 98.32%, exceeding every configured critical gate.
- [x] Verified: syntax, type, package dry-run, and diff checks pass after the package dependency, concurrency, renderer, and project-review updates.

## 2026-07-11 - Environment documentation reconciliation

- [x] Verified: README documents each environment variable read by the runtime, distinguishes `OTM_HOME`, `OTM_STATE_DIR`, and `CODEX_HOME`, and records the CI postinstall safeguard.
- [x] Verified: SQLite documentation now matches the required dependency/CI policy while retaining JSON as an explicit backend selection.
- Verification: source-variable audit, syntax, and diff checks passed.

## 2026-07-11 - Explainable memory ranking

- [x] Verified: memory search uses normalized tokens with exact phrase, title, tag, body, recency, and explicit score-hint weighting, and returns structured `matchReasons` for each result.
- [x] Verified: architecture documentation records the weighting and normal expired-memory filtering.
- Verification: focused memory-ranking tests, syntax, and diff checks passed.

## 2026-07-11 - Expanded evidence redaction coverage

- [x] Verified: shared evidence/scratch redaction now handles prefixed dotenv secret variable names, AWS access keys, Google API keys, Slack tokens, JWTs, authorization headers, private keys, and existing OpenAI/GitHub token patterns.
- Verification: focused secret-pattern regression, syntax, and diff checks passed.

## 2026-07-11 - Hook evidence capture and per-tool deduplication

- [x] Verified: `OTM_COMMAND_CAPTURE` now has explicit `redacted`, `none`, and `validation-only` policies. Command text is redacted before either inline evidence or scratch persistence; bare dotenv-style `token=...` assignments are covered alongside cloud tokens, headers, JWTs, and private keys.
- [x] Verified: hook deduplication uses invocation/tool-use identities when supplied, then hashes full tool payloads rather than treating a turn ID as the identity for all tool events. Identical duplicate installations still collapse while legitimate same-turn tools remain observable.
- Verification: focused hook capture/deduplication and secret-redaction regressions passed; syntax and diff checks passed.

## 2026-07-11 - Installer safety suite and complete verification checkpoint

- [x] Verified: installer dry-run, rollback-after-late-failure, malformed-hook preflight, and duplicate-marker preflight regressions now live in a dedicated installer suite instead of only the broad manager suite.
- [x] Verified: scratch capture uses a fixed timestamp/hash filename and never incorporates host-provided tool names, preventing an MCP tool name from changing the target path.
- Verification: `npm test` passed 118 tests (0 failures/skips); `npm run coverage` passed at 91.60% overall (manager 93.64%, JSON 97.06%, SQLite 95.39%, validation 98.33%); lint, format check, type check, syntax check (56 modules), `npm pack --dry-run`, and `git diff --check` all passed.

## 2026-07-11 - Mandatory path regressions and test-fixture lifecycle

- [x] Verified: malicious summary/turn identifiers remain durable metadata while published summary paths use fixed hash-based names; explicit AGENTS installation targets reject traversal and absolute external paths.
- [x] Verified: hook evidence policy reads the injected environment instead of process-global state, and fail-open evidence-mutation failures now return a redacted host diagnostic instead of being silently discarded.
- [x] Verified: all test modules track their real temporary workspaces/state directories and remove them in a shared post-test cleanup hook.
- Verification: `npm test` passed 121 tests (0 failures/skips); `npm run coverage` passed at 91.69% overall (manager 93.64%, JSON 97.06%, SQLite 95.39%, validation 98.33%); lint, format check, type check, syntax check (57 modules), `npm pack --dry-run`, and `git diff --check` all passed.

## 2026-07-11 - Core lifecycle suite extraction

- [x] Verified: terminal internal-step normalization, unsafe initial route state rejection, evidence/force-completion enforcement, and completed-task drop guards now have a dedicated lifecycle suite rather than living only in the broad manager integration test.
- Verification: focused lifecycle plus manager tests passed 77 tests; syntax and diff checks passed. The previous complete-suite/coverage checkpoint remains valid for runtime behavior; rerun the complete matrix after the remaining extraction and audit work.

## 2026-07-11 - Backend metadata and direct-evidence conformance

- [x] Verified: JSON cache upserts now preserve an entry's original `createdAt`, matching SQLite and the memory-update contract; a shared backend conformance regression proves the behavior.
- [x] Verified: direct lifecycle evidence now applies bounded kind, summary, command, files, notes, and exit-code validation instead of relying only on MCP input schemas.
- [x] Verified: duplicate guidance and Stop-loop/fail-open regressions now live in the focused hook suite; manager coverage remains the broad integration lane.
- Verification: full `npm test` passed 123 tests (0 failures/skips); `npm run coverage` passed at 91.40% overall (manager 93.74%, JSON 96.61%, SQLite 95.39%, validation 98.33%); lint, format check, type check, syntax check (59 modules), `npm pack --dry-run`, and `git diff --check` all passed.

## 2026-07-11 - Explicit state-transition matrices

- [x] Verified: task and run state edges are now defined in one shared state-machine module and public lifecycle operations validate their edge before committing the revisioned store mutation.
- [x] Verified: unit tests enumerate every allowed matrix edge and reject representative invalid task and run edges with structured `INVALID_TRANSITION` details.
- Verification: focused state-machine, lifecycle, concurrency, and manager tests passed; syntax and diff checks passed. Full verification is pending the next audit milestone.

## 2026-07-11 - Reconciliation and direct-task boundary completion

- [x] Verified: reconciliation replace, activate, reopen, add/merge, drop, supersede, and automatic task selection validate all existing before/after task edges before the single revisioned commit; ordinary activation cannot revive blocked work outside the recorded resume/reopen path.
- [x] Verified: direct route/reconcile task inputs now enforce bounded identifiers, title/description lengths, criteria/evidence counts, priorities, sort orders, dependency IDs, and initial evidence normalization.
- Verification: full `npm test` passed 126 tests (0 failures/skips); `npm run coverage` passed at 91.54% overall (manager 93.70%, JSON 97.07%, SQLite 95.39%, validation 98.33%); lint, format check, type check, syntax check (61 modules), `npm pack --dry-run`, and `git diff --check` all passed.

## 2026-07-11 - MCP bounds and explicit abandonment surface

- [x] Verified: every MCP tool schema now receives declared string/array bounds, with lifecycle numeric fields constrained to the manager-compatible ranges; protocol regressions cover invalid cleanup age, step index, and evidence exit code.
- [x] Verified: incomplete finalization accepts its required reason through MCP, and explicit abandonment is exposed through `otm_abandon` and confirmation-gated `otm abandon` rather than relying on a hidden manager-only method.
- Verification: focused CLI, MCP protocol, and lifecycle tests passed; syntax and diff checks passed. Full verification is pending the next audit milestone.

## 2026-07-11 - CLI abandonment discovery parity

- [x] Verified: the confirmation-gated abandonment command is listed in built-in CLI help as well as README and MCP tool discovery; a CLI regression prevents future help drift.
- Verification: CLI tests, syntax check, and diff check passed.

## 2026-07-11 - Final summary memory identity isolation

- [x] Verified: finalization now derives turn-summary memory IDs from durable run and summary IDs, so separate routes with the same goal cannot overwrite one another while retries retain one record for the same operation.
- Verification: focused lifecycle and manager suites, syntax check, and diff check passed.

## 2026-07-11 - Trusted AGENTS synchronization

- [x] Implemented - Unverified: SessionStart leaves `AGENTS.md` unmodified by default. Managed instruction synchronization now requires both `OTM_AUTO_SYNC_AGENTS=1` and `OTM_TRUSTED_INSTALLATION=1`, while the explicit workspace installer remains available for intentional setup.
- [x] Implemented - Unverified: regression coverage exercises a missing `AGENTS.md` and an existing untrusted file, in addition to the trusted marker-only refresh path. README and architecture documentation now describe the two-flag contract.

## 2026-07-11 - Fail-closed current snapshot handling

- [x] Implemented - Unverified: malformed OTM `current.json` artifacts are no longer converted to empty objects during current-file writes, workspace-index rebuilds, clear fallback lookup, or JSON MCP resource reads. The original bytes remain in place and operations return a typed corruption/read failure for doctor or repair.
- [x] Implemented - Unverified: renderer coverage proves both unscoped and workspace-index corruption prevent a replacement write.

## 2026-07-11 - Visible, redacted hook maintenance diagnostics

- [x] Implemented - Unverified: hook startup cleanup remains fail-open but now attaches a redacted diagnostic instead of swallowing an error; Stop-hook finalization errors are redacted before host output. SQLite missing-dependency language and README recovery instructions now consistently describe `better-sqlite3` as required.

## 2026-07-11 - Clear lifecycle maintenance reporting

- [x] Implemented - Unverified: automatic history pruning after a durable clear is still non-blocking, but a failure is now returned in structured maintenance metadata and Markdown with secrets redacted rather than being silently discarded.

## 2026-07-11 - Snapshot internal-step normalization

- [x] Implemented - Unverified: renderer snapshots retain internal steps only in each task's top-level `internalSteps` field and remove the duplicate `metadata.internalSteps` projection, while durable task records retain their existing metadata representation.

## 2026-07-11 - Doctor stale-lock audit and migration documentation reconciliation

- [x] Implemented - Unverified: doctor regression coverage now seeds malformed storage, duplicate active scope, orphan references, snapshot-index divergence, and a stale-looking JSON lock without allowing doctor to mutate them.
- [x] Implemented - Unverified: the changelog now correctly states SQLite v1/v2 upgrade through schema v3 rather than the obsolete v2 target.

## 2026-07-11 - Final production-hardening verification

- [x] Verified: `npm ci --foreground-scripts` rebuilt and loaded required `better-sqlite3@11.10.0` (SQLite `3.49.2`) without performing global OTM setup.
- [x] Verified: full test suite passed 131 tests with zero failures or skips. This includes required SQLite conformance/migration lanes, multi-process races, lifecycle/state-machine, installer, CLI/doctor, MCP, path/redaction, hooks, project review, planner, and renderer coverage.
- [x] Verified: coverage passed at 92.07% overall, with manager 95.74%, JSON 96.61%, SQLite 95.39%, and validation 98.33%; lint, format, checked syntax/type, package dry-run, and diff checks passed.
- [x] Verified: implementation committed locally as `e9e3219ff437497c851c72c3a79f0c8e16b80837` on `codex/full-production-hardening`; no remote push was requested or performed. The pre-existing deleted `AGENTS.md` and `.codex-plugin/plugin.json` remain intentionally unstaged.

## 2026-07-11 - Static unsafe-leftover sweep

- [x] Verified: repository sweep found no `INSERT OR REPLACE`, unguarded raw external IDs in filesystem paths, or placeholder/TODO implementation markers in runtime code.
- [x] Verified: remaining empty catches are restricted to explicit cleanup, lock-recovery, or documented hook fail-open paths; destructive filesystem operations remain in confirmation/preflight/rollback controlled installer or cleanup paths.
- [x] Verified: the shared JSON/SQLite contract now proves empty cache deletion selectors are rejected and expired-cache deletion remains explicit.
- Verification: all extracted suite-targeted tests, syntax checks, and diff checks passed. Full coverage must be rerun after the current extraction milestone.

## 2026-07-11 - Read-only doctor and complete dry-run storage safety

- [x] Verified: CLI and MCP doctor inspect raw JSON/SQLite state without instantiating a normal store. They report malformed state, duplicate active scopes, orphaned records, invalid statuses, stale locks, workspace snapshot-index divergence, hook JSON syntax, SQLite integrity, and schema health without quarantining or rewriting files.
- [x] Verified: MCP server now creates a storage manager lazily, so `otm_doctor` itself does not initialize an empty store. `doctor --repair` is an explicit opt-in and refuses repair when integrity errors are present.
- [x] Verified: dry-run CLI operations use read-only storage views; a missing JSON backend stays absent and JSON `pruneHistory({ dryRun: true })` no longer takes a write transaction, rewrites state, or rotates a recovery backup.
- Verification: `npm test` passed 111 tests; `npm run coverage` passed at 90.47% overall (manager 92.71%, JSON 97.29%, SQLite 95.06%, validation 98.32%); `npm run syntax:check` and `git diff --check` passed.

## 2026-07-11 - SQLite v3 durable validation and preview cleanup

- [x] Verified: SQLite schema v3 is an ordered, backed-up migration from v2. It adds durable abort triggers for valid run/task status values, task `required` booleans, and summary `current_cleared` booleans without rebuilding legacy tables.
- [x] Verified: partial legacy schemas are completed transactionally before migrations reference their dependent tables; v1 and v2 migration fixtures retain their pre-migration database backup.
- [x] Verified: malformed v2 status/boolean rows are reported by read-only doctor and block v3 migration rather than silently surviving it; the blocked upgrade still retains a v2 backup for manual repair.
- [x] Verified: `otm cleanup --dry-run` and `otm_cleanup_workspace` preview OTM-owned temp/scratch files without deletion or store initialization, while retaining the all-session confirmation requirement.
- Verification: targeted v1/v2 migration, cleanup, doctor, MCP, and dry-run tests passed; syntax and diff checks passed. Full coverage needs rerun after this milestone.

## 2026-07-11 - Reversible workspace installer lifecycle

- [x] Verified: `otm uninstall --dry-run` is side-effect free through both the library and CLI paths; CLI lifecycle commands do not initialize a store before previewing.
- [x] Verified: applied workspace uninstall is confirmation-gated, runs complete read-only preflight, snapshots every affected file/directory, rolls back on failure, and records a recovery manifest.
- [x] Verified: uninstall removes only marker-delimited AGENTS/gitignore/MCP content and structurally matched OTM hook commands; unrelated hooks/configuration and modified skill directories are retained.
- [x] Verified: `--remove-state` refuses active or malformed current snapshots and puts backup/manifest material outside the state directory that may be deleted.
- [x] Verified: skill installation and install manifests track all packaged files in a skill directory, not only `SKILL.md`.
- Verification: `node --test tests/manager.test.mjs` passed 94 tests; `npm run coverage` passed with 87.71% overall and all required critical module line thresholds; `npm run syntax:check` and `git diff --check` passed.

## 2026-07-11 - Historical exchange and Windows index-lock recovery

- [x] Verified: workspace export/import covers runs, tasks, events, summaries, and memory through both JSON and SQLite store interfaces; import is one transaction, rejects record/idempotency collisions, and preserves timestamps.
- [x] Verified: import accepts only matching-canonical-workspace terminal history with complete reference/ID/timestamp validation; it cannot create an active route.
- [x] Verified: the workspace current-index lock handles a transient Windows `EPERM` as contention and only reclaims an aged lock when its owner PID is dead.
- [x] Verified: opening an existing JSON state validates it without rewriting the document or rotating a backup.
- Verification: focused cross-process and export/import tests passed; `npm test` passed 99 tests with SQLite required; `git diff --check` passed.

## 2026-07-11 - Explicit resume and archival lifecycle

- [x] Verified: only an unfinished blocked or paused route may resume; resumption reactivates one scoped task, preserves blocker evidence, clears stale completion state, and emits a durable `run_resumed` event.
- [x] Verified: only a finalized terminal route may archive; archival is idempotent, revisioned, scoped to workspace/session, and emits `run_archived`.
- [x] Verified: the CLI requires `--run-id` for resume/archive and `--confirm` for archive.
- Verification: full coverage suite passed 101 tests, 87.96% overall line coverage, and all critical coverage gates; `git diff --check` and `npm pack --dry-run` passed.

## 2026-07-11 - MCP protocol and destructive-memory contract

- [x] Verified: a real stdio MCP client discovers tools, safely rejects malformed arguments with MCP error semantics, receives the closed structured result envelope, and reads a workspace/session-scoped resource.
- [x] Verified: MCP executable stderr redacts credential-shaped data and omits stack traces; resume/archive are available through MCP with destructive annotations where relevant.
- [x] Verified: workspace-wide memory deletion requires `all:true` and explicit confirmation; dry-run reports the exact matched entries without mutation.
- Verification: `npm test` passed 103 tests; `npm run coverage` passed at 89.63% overall with all lifecycle/storage/security-critical line gates satisfied; `git diff --check` passed.

## 2026-07-11 - Global installer ownership and removal

- [x] Verified: global install persists a transaction backup and install ownership manifest in addition to the legacy hooks backup.
- [x] Verified: `otm uninstall --global` is previewable and confirmation-gated; it removes only structurally matched OTM hooks and fully unmodified packaged skill trees.
- [x] Verified: malformed global hook JSON blocks all removal, modified global skills are preserved, and an applied global uninstall leaves recovery manifests/backups.
- Verification: `npm test` passed 105 tests; `npm run coverage` passed at 89.37% overall with all critical module gates; `npm run syntax:check`, `git diff --check`, and `npm pack --dry-run` passed.

## 2026-07-11 - Nested MCP schemas and JSON conformance recovery

- [x] Verified: reusable bounded JSON schemas now define task, evidence, internal-step, reconciliation, and structured-context inputs; nested unknown fields, invalid types, and oversized arrays are rejected before manager dispatch.
- [x] Verified: compatibility fields used by category-aware planning remain accepted, while unsupported nested fields do not silently bypass MCP validation.
- [x] Verified: a JSON-specific conformance regression covers route replacement and direct task helper behavior, keeping the critical JSON-store coverage gate above 90%.
- Verification: `npm test` passed 106 tests; `npm run coverage` passed at 89.69% overall (JSON 97.02%); `git diff --check` passed.

## 2026-07-11 - Expanded backend conformance contract

- [x] Verified: both storage backends reject competing active scopes, support explicit route replacement, and preserve deterministic task order.
- [x] Verified: both backends share summary upsert/current-cleared behavior and prune terminal historical runs while preserving active runs.
- Verification: dedicated storage conformance passed 8 tests; full coverage passed 108 tests, 90.16% overall, and all critical module thresholds.

## 2026-07-07 - Hook termination and lifecycle concurrency hardening

- [x] Verified: missing hook identity cannot read, mutate, or stop-gate a legacy or unrelated route.
- [x] Verified: global and workspace hook commands are deduplicated per host invocation.
- [x] Verified: repeated Stop feedback and Stop-hook failures release instead of looping indefinitely.
- [x] Verified: implicit legacy adoption is disabled; intentional migration requires `OTM_CLAIM_LEGACY_ROUTE=1`.
- [x] Verified: unscoped diagnostics preserve the multi-session index and scoped scratch cleanup preserves other chats.
- [x] Verified: separate finalize and clear calls mark both the run and summary cleared.
- [x] Verified: dropped/superseded tasks terminalize internal steps and stale terminal progress is rejected.
- Verification: `npm test` passed all 43 tests across JSON and SQLite multi-project/multi-chat cases, including a real two-process hook-deduplication test; `npm run syntax:check` passed 38 modules; `npm pack --dry-run` included all runtime, hook, skill, and documentation files; `git diff --check` passed.

## 2026-07-05 - Concurrent route isolation

- [x] Verified: active routes are scoped by workspace plus Codex session.
- [x] Verified: two sessions in one workspace retain separate active runs and canonical current files.
- [x] Verified: one session identity across two workspaces retains separate routes.
- [x] Verified: legacy unscoped routes are claimed once and explicit cross-session run access is rejected.
- [x] Verified: session cleanup preserves other sessions' scratch evidence.
- [x] Verified: JSON mutations use a cross-process lock; SQLite has a workspace/session/status index.
- [x] Verified: three repeated two-process JSON-store/index races preserved both active routes.
- Installed `better-sqlite3` 11.10.0 from the declared optional dependency and generated `package-lock.json`; native load reports SQLite 3.49.2.
- Verification: `npm test` passed all 32 tests (including SQLite and a real two-process race), `npm run syntax:check` passed 38 modules, `npm pack --dry-run` included the new session-scope module, and `git diff --check` passed.
