# Security Policy

## Reporting

Please report suspected vulnerabilities privately to the repository maintainers. Do not include credentials, private data, or exploit payloads in public issues.

## Data handling

OTM stores route metadata, evidence, summaries, and optional project-review cache locally. Evidence is redacted for common authorization headers, bearer tokens, API keys, password assignments, and private-key blocks before OTM persists it. This is defense in depth, not a safe place to intentionally submit secrets.

## Operational boundaries

- User-derived paths are constrained to the selected workspace.
- Destructive memory operations require selectors; use preview/dry-run where available.
- JSON corruption is quarantined rather than overwritten.
- SQLite migrations make a pre-migration backup before schema upgrade.
- Hook and installer diagnostics should be reviewed before modifying global Codex configuration.
