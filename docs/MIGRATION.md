# Migration guide

## SQLite schema v1 to v5

OTM records the SQLite store schema separately from the package version using
`PRAGMA user_version`. Opening an older store with OTM 0.2.0 runs ordered
migrations transactionally through schema v5.

Before migration, OTM checkpoints WAL state and creates
`state.sqlite.pre-migration-v<previous-version>-<timestamp>.bak` beside the
database. The v2 migration adds the unique active-route index for a workspace
and session. The v3 migration adds database-level
validation triggers for run/task statuses and required boolean fields. The v4
migration rebuilds legacy `tasks`, `events`, and `summaries` tables with
`ON DELETE CASCADE` foreign keys to `runs`. The v5 migration adds the durable
root-session binding table, workspace aliases, primary workspace, and bounded
resolution metadata without rewriting or deleting route history.

OTM inspects the actual foreign-key layout instead of trusting
`PRAGMA user_version` alone. A legacy database that incorrectly claims the
current version but lacks required foreign keys receives the same recoverable
backup and corrective v4 rebuild. Opening schema v5 also recreates the binding
table if an interrupted or partial install omitted it. Orphaned legacy rows
block the transaction and leave the original database plus backup available
for manual repair. Existing v1-v4 runs remain intact and are associated with a
root session only through a deterministic, one-time legacy resolution; an
ambiguous resolution remains available for explicit review.

If migration reports duplicate active scopes, no migration is applied. Run `otm doctor`, identify the duplicate routes, retain the desired active route, and archive or explicitly abandon the others before retrying. Keep the backup until `otm doctor` reports SQLite integrity `ok`.

## JSON stores

JSON state is validated on every open. Invalid JSON, duplicate identifiers, or orphaned records are quarantined as `state.json.corrupt-<timestamp>` instead of being reset. Restore the adjacent `state.json.backup` only after preserving the corrupt file for diagnosis.
