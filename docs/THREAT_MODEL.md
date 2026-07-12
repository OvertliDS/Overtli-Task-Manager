# Threat model

## Assets

Route state, task evidence, summaries, project memory, workspace snapshots, hook configuration, and installation manifests are local assets protected by this package.

## Primary controls

- Canonical workspace identity and session scope prevent cross-workspace and cross-chat task mutation.
- Root-contained path resolution rejects traversal, absolute external targets, and symlink escape.
- SQLite uses foreign keys, schema migrations, integrity checks, and active-scope uniqueness; JSON validates references and quarantines corruption.
- Evidence and scratch capture redact common credential patterns before persistence.
- Installation is preflighted; malformed configuration prevents writes; global changes require explicit opt-in.
- Deletion requires selectors, previews are available for memory cleanup, and active-route clearing requires finalization or explicit abandonment.

## Residual risks

Redaction is heuristic and must not be treated as permission to submit secrets. Local filesystem access controls remain the operating-system owner’s responsibility. Workspace documents and hook payloads are untrusted input and should be reviewed before using their contents as instructions.
