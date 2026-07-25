---
name: overtli-task-manager-install
description: Install or repair Overtli Task Manager in a Codex workspace, including AGENTS.md managed block, repo skills under .agents/skills, .codex/hooks.json, gitignore entries, optional project MCP config, and doctor checks.
---

# Install Overtli Task Manager

Use this skill when the user asks to install, initialize, repair, configure, or enable Overtli Task Manager in a repository.

## Required flow

1. Run `otm_install_workspace` with the current repository root as `workspaceRoot`; use `dryRun=true` if the user wants a preview.
2. Run `otm_install_workspace` with `dryRun=false` when applying.
3. Do not duplicate AGENTS.md content. The installer owns only the block between OTM markers.
4. Confirm the managed block tells the model to preserve per-gate work types for mixed planning/review/documentation/implementation prompts while keeping detailed schemas in the packaged skill.
5. Patch root `AGENTS.md` by default. If `AGENTS.override.md` exists, report that it was not patched; pass `targetAgentsFile: "AGENTS.override.md"` only when the user explicitly wants the override file patched.
6. Install repo skills into `.agents/skills` so Codex can discover them from the repository root.
7. Install hooks into `.codex/hooks.json` without removing unrelated hooks.
8. Add only narrow OTM runtime paths to `.gitignore`.
9. Use optional project MCP config only when the user wants project-scoped MCP configuration. Otherwise provide the `otm mcp-config` snippet for global Codex config.
10. Run `otm_doctor` after installation.

For a requested global refresh, run `otm install-global` from the installed
plugin copy after updating it. Global and workspace hook entries may coexist;
runtime invocation deduplication prevents duplicate guidance and Stop feedback.
Verify both the configured command paths and a real hook smoke invocation.
Also verify the active Node ABI can load the installed `better-sqlite3` binding,
or that `OTM_STORAGE=auto` reports a safe JSON fallback after its bounded
repair attempt. Confirm all four skills, all seven hook events, the managed
AGENTS block, and the MCP entry point came from the updated installed copy.

## Safety

- If a managed block has only one marker, stop and report manual repair instructions.
- If an unmanaged MCP server with the same name already exists, do not overwrite it.
- Preserve existing repository instructions and hooks.
