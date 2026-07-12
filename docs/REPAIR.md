# Repair guide

`otm doctor` is read-only. It parses JSON without quarantining it and opens SQLite read-only, then reports the selected backend, schema/integrity state, duplicate active scopes, orphan records, invalid statuses, lock state, current-file/index divergence, hooks JSON health, and JSON backup availability.

- **Malformed JSON:** preserve the generated quarantine file; restore the last known-good backup only after stopping all OTM processes.
- **SQLite integrity failure:** retain the database and migration backup, stop OTM processes, and restore a known-good backup. Do not delete the WAL files while a process is open.
- **Duplicate active scope:** resolve routes explicitly through OTM lifecycle operations; do not edit durable rows by hand unless recovering from a backup.
- **Malformed hooks configuration:** repair the JSON manually, then rerun `otm install --dry-run` before applying installation.

No doctor invocation performs repair implicitly. `otm doctor --repair` is the
explicit exception for republishing existing durable summary records after the
report is free of integrity errors; use `--dry-run` first to preview it.

## Summary-file repair

If durable summary records exist but files under `.codex/overtli-task-manager/summaries/` are missing after an interrupted write, preview and republish them explicitly:

```powershell
otm repair --workspace <path> --dry-run
otm repair --workspace <path>
```

This operation rebuilds only generated summary Markdown/JSON files from durable summary records; it does not modify route history or memory.
