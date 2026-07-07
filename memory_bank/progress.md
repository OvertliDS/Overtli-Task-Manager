# Progress

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
