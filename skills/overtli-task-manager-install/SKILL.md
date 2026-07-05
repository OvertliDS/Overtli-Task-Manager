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
4. Patch root `AGENTS.md` by default. If `AGENTS.override.md` exists, report that it was not patched; pass `targetAgentsFile: "AGENTS.override.md"` only when the user explicitly wants the override file patched.
5. Install repo skills into `.agents/skills` so Codex can discover them from the repository root.
6. Install hooks into `.codex/hooks.json` without removing unrelated hooks.
7. Add only narrow OTM runtime paths to `.gitignore`.
8. Use optional project MCP config only when the user wants project-scoped MCP configuration. Otherwise provide the `otm mcp-config` snippet for global Codex config.
9. Run `otm_doctor` after installation.

## Safety

- If a managed block has only one marker, stop and report manual repair instructions.
- If an unmanaged MCP server with the same name already exists, do not overwrite it.
- Preserve existing repository instructions and hooks.
