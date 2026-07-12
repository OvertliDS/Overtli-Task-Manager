# Changelog

## 0.2.0 - Unreleased

### Security and lifecycle hardening

- Canonical workspace/path validation rejects traversal and root escapes.
- Route creation is atomic across run, tasks, and initial event, with an active workspace/session uniqueness invariant.
- Public route inputs cannot initialize terminal task states, bypass evidence, or mutate cross-run tasks.
- SQLite migrations use `PRAGMA user_version`, recoverable pre-migration backups, and strict JSON-column parsing.
- Corrupt JSON state is quarantined and reported instead of reset.
- Hook evidence and scratch command capture redact common credential patterns.
- Workspace installation is preflighted and dry-run is side-effect free.

### Compatibility

- Node.js 20.10+ remains supported.
- Existing SQLite v1 and v2 stores are migrated through ordered schema v3 migrations on open. A `state.sqlite.pre-migration-v<previous-version>-*.bak` recovery copy is retained before each upgrade.
- JSON remains supported as a validated fallback store.
