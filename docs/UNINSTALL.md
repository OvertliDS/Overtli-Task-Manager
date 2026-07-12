# Uninstall guide

Run a preview from the target workspace before making changes:

```bash
otm uninstall --dry-run
otm uninstall --confirm
```

Uninstall is confirmation-gated and transactional. It removes only OTM marker
blocks from `AGENTS.md`, `.gitignore`, and project MCP configuration; it removes
only structurally identified OTM commands from `hooks.json`; and it removes a
packaged skill directory only when every file still matches the package. Mixed
or user-modified skill directories are reported and preserved. Every applied
uninstall creates a recovery backup and manifest.

Global removal is also explicit, previewable, confirmation-gated, and transactional:

```bash
otm uninstall --global --dry-run
otm uninstall --global --confirm
```

It removes only structurally identified OTM commands from `~/.codex/hooks.json`
and fully matching packaged skills from `~/.codex/skills`; unrelated hooks and
modified skill directories remain intact. The global uninstall manifest and
recoverable backups are kept under `~/.codex/overtli-task-manager-backups/`.

For workspace state, remove only the OTM-managed paths after confirming no active route needs recovery:

```text
.codex/overtli-task-manager/
.agents/skills/overtli-task-manager*/
```

Retain SQLite/JSON backups and summaries until the route history is no longer required. `otm uninstall` retains workspace state by default. To remove it after a separate backup and review, use `otm uninstall --confirm --remove-state`; the recovery manifest is written outside the removed state directory. Do not remove a mixed `AGENTS.md` file wholesale; remove only the OTM marker block.
