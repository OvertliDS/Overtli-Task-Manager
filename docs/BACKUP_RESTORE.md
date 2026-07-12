# Backup and restore

For portable, workspace-scoped historical data (runs, tasks, events, summaries,
and memory), use `otm export --output history.json`. Import is intentionally
confirmation-gated and accepts only terminal historical routes for the same
canonical workspace; it never creates an active route from imported data:

```bash
otm export --output otm-history.json
otm import --input otm-history.json --confirm
```

SQLite migrations create a pre-migration `.bak` file. JSON writes keep a last-known-good `state.json.backup` file. Use `otm backup` for an explicit recovery image; SQLite backups use the SQLite backup API rather than copying a WAL database file directly.

To inspect health without changing state, run:

```powershell
otm doctor --workspace <path>
```

Create a backup explicitly:

```powershell
otm backup --output C:\safe-location\otm-backup.sqlite
```

Restore only after reviewing the input and stopping other OTM/MCP processes:

```powershell
otm restore --input C:\safe-location\otm-backup.sqlite --confirm
```

`otm restore --dry-run` reports the selected target without writing. SQLite restore removes stale WAL/SHM sidecars after restoring the confirmed database image. Never overwrite a quarantined corrupt file; retain it for diagnosis.

Current workspace snapshots under `.codex/overtli-task-manager/` are views of durable state, not a substitute for a store backup.
