# Migration guide

## SQLite schema v1 to v4

OTM records the SQLite store schema separately from the package version using
`PRAGMA user_version`. Opening an older store with OTM 0.2.0 runs ordered
migrations transactionally through schema v4.

Before migration, OTM checkpoints WAL state and creates
`state.sqlite.pre-migration-v<previous-version>-<timestamp>.bak` beside the
database. The v2 migration adds the unique active-route scope index for
canonical workspace plus session. The v3 migration adds database-level
validation triggers for run/task statuses and required boolean fields. The v4
migration rebuilds legacy `tasks`, `events`, and `summaries` tables with
`ON DELETE CASCADE` foreign keys to `runs`.

OTM inspects the actual foreign-key layout instead of trusting
`PRAGMA user_version` alone. A legacy database that incorrectly claims the
current version but lacks the required constraints receives the same recoverable
backup and corrective v4 rebuild. Orphaned legacy rows block the transaction and
leave the original database plus backup available for manual repair.

If migration reports duplicate active scopes, no migration is applied. Run `otm doctor`, identify the duplicate routes, retain the desired active route, and archive or explicitly abandon the others before retrying. Keep the backup until `otm doctor` reports SQLite integrity `ok`.

## JSON stores

JSON state is validated on every open. Invalid JSON, duplicate identifiers, or orphaned records are quarantined as `state.json.corrupt-<timestamp>` instead of being reset. Restore the adjacent `state.json.backup` only after preserving the corrupt file for diagnosis.
