# Progress

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
