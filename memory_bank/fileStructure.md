# File Structure Knowledge Base

## Concurrent route state

| Path | Responsibility | Invariants |
|---|---|---|
| `src/core/session-scope.mjs` | Resolves explicit/environment session ids and stable hashed session keys. | Resolution order is explicit input, `OTM_SESSION_ID`, then `CODEX_THREAD_ID`. |
| `src/core/manager.mjs` | Validates workspace/session scope, claims legacy routes, and coordinates lifecycle operations. | `replaceExisting` and implicit active lookup affect only the resolved workspace/session. |
| `src/storage/sqlite-store.mjs` | Durable concurrent store with WAL mode. | Active lookup includes workspace, nullable session id, and active statuses. |
| `src/storage/json-store.mjs` | JSON fallback store. | Every mutation holds `state.lock`; stale locks older than 30 seconds may be recovered. |
| `src/core/renderer.mjs` | Writes canonical session snapshots and rebuilds the workspace index. | Session snapshots are authoritative; top-level current files are an index. |
| `src/hooks/runner.mjs` | Propagates hook `session_id` or environment thread identity. | Stop/progress/compact hooks operate only on their session route. |
| `.codex/overtli-task-manager/sessions/<session-key>/` | Runtime route state and session-owned scratch evidence. | Generated and ignored by Git; do not edit manually. |

Flow: hook or MCP input -> session resolution -> workspace/session active lookup -> durable store mutation -> canonical session snapshot -> workspace index refresh.
