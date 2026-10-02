# Threat model

## Assets

Route state, task evidence, summaries, project memory, workspace snapshots, hook configuration, and installation manifests are local assets protected by this package.

## Primary controls

- Root-session identity separates Codex chats; persisted workspace aliases resolve the same chat to its current route without changing the route's primary evidence location. Explicit runs from another session are rejected.
- Root-contained path resolution rejects traversal, absolute external targets, and symlink escape.
- SQLite uses foreign keys, schema migrations, integrity checks, a root-session binding, and active-route uniqueness; JSON validates references and quarantines corruption. Ambiguous legacy ownership requires explicit same-session route selection.
- Evidence and scratch capture redact common credential patterns before persistence.
- Installation is preflighted; malformed configuration prevents writes; global changes require explicit opt-in.
- Deletion requires selectors, previews are available for memory cleanup, and active-route clearing requires finalization or explicit abandonment.

## Residual risks

Redaction is heuristic and must not be treated as permission to submit secrets. Local filesystem access controls remain the operating-system owner’s responsibility. Workspace documents and hook payloads are untrusted input and should be reviewed before using their contents as instructions.
