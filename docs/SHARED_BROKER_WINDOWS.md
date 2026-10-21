# Shared Overtli Task Manager MCP: Windows runbook

## Installed architecture

Codex Desktop may spawn one MCP process tree for each chat and subagent. The Task Manager now uses one local Node.js backend (bin/otm-broker.mjs), on 127.0.0.1:18989, and a lightweight Python stdio client (bin/otm-proxy.py) per Codex connection. The proxy preserves each caller's CODEX_THREAD_ID, OTM_SESSION_ID, working directory, and OTM storage environment so task routes do not mix.

The broker is started by the Windows Scheduled Task named "Overtli Task Manager Shared MCP" on user login. The broker accepts authenticated localhost connections only; its private token lives under LOCALAPPDATA/Overtli/TaskManager/broker-token. Keep that token confidential. A Python client falls back to bin/otm-mcp.mjs if the broker is unavailable.

## Tool availability

Codex global config remains at USERPROFILE/.codex/config.toml. Node REPL, Overtli Task Manager and shared HTTP application MCPs are enabled. Optional stdio servers are disabled globally but can be activated with CLI profiles in separate *.config.toml files, for example: codex --profile overtli_design

- overtli_design: Figma Console
- overtli_ui: Shadcn
- overtli_reasoning: Clear Thought
- overtli_media: Pollinations
- overtli_unity: Unity MCP
- overtli_docs: MarkItDown
- overtli_creative: Figma, Pollinations, Shadcn

The Codex desktop app may not support selecting CLI profiles. To make an optional MCP globally available to desktop sessions, change its base enabled value and safely restart Codex.

## Verification

Run codex mcp list and check OTM uses otm-proxy.py; Node REPL must remain enabled. Run Get-NetTCPConnection -LocalPort 18989 -State Listen and check a single broker process. Run Get-ScheduledTask -TaskName 'Overtli Task Manager Shared MCP' to inspect startup state.

From the plugin root:

- node --test tests/mcp-protocol.test.mjs tests/shared-broker.test.mjs
- node --test

2026-10-08 results: legacy protocol 4/4 passed; session-isolation integration passed with two clients and all 25 tools. Fallback mode passed. Twenty-five separate client opens/closes plus snapshots leaked no connections and showed only +0.2 MB broker private memory growth. Full original suite: 185/185 passed before new broker test; see latest test run for updated count.

## Lifecycle and recovery

The changed Codex configuration applies to newly initialized MCP stacks; it cannot safely terminate stale stdio servers attached to currently running chats and agents. Do not terminate Codex or its child processes in the middle of implementation work. After all active threads have saved checkpoints, restart Codex normally to reclaim old process trees. Per-agent Node REPL and Codex-bundled helpers remain dependent on upstream Codex lifecycle behavior.

Backups exist in USERPROFILE/.codex/config.toml.before-_-20261008-_.bak and src/mcp/server.mjs.pre-shared-broker-20261008.bak. To revert the OTM transport, restore the old global command/args (node + bin/otm-mcp.mjs), preserving its environment, and restart Codex safely. The proxy can already fall back without a config edit if the broker is unreachable. Installing/upgrading the plugin may overwrite customized broker files; retain this runbook and regression test.
