import path from 'node:path';
import { createTaskManager } from '../core/manager.mjs';
import { findWorkspaceRoot, currentJsonPath, readJson, pathExists, readText } from '../core/fs-utils.mjs';
import { installWorkspace, renderInstallResult } from '../install/install-workspace.mjs';
import { installGlobal, renderGlobalInstallResult } from '../install/install-global.mjs';
import { reviewProjectContext } from '../context/project-review.mjs';
import { runHookScript } from '../hooks/runner.mjs';
import { resolveSessionId } from '../core/session-scope.mjs';

export async function handleCli({ argv, cwd, stdin, packageRoot, env }) {
  const command = argv[0] || 'help';
  const flags = parseFlags(argv.slice(1));
  const workspaceRoot = path.resolve(flags.workspace || flags.workspaceRoot || findWorkspaceRoot(cwd));
  const sessionId = resolveSessionId({ sessionId: flags.sessionId }, env);
  const manager = createTaskManager({ cwd: workspaceRoot, env });

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(helpText());
    return;
  }

  if (command === 'install') {
    const result = installWorkspace({
      cwd,
      workspaceRoot,
      packageRoot,
      dryRun: Boolean(flags.dryRun),
      installMcpConfig: Boolean(flags.withProjectMcpConfig),
      targetAgentsFile: flags.agentsFile || null
    });
    console.log(renderInstallResult(result));
    return;
  }

  if (command === 'install-global') {
    const result = installGlobal({
      codexHome: flags.codexHome || env.CODEX_HOME || null,
      packageRoot,
      dryRun: Boolean(flags.dryRun),
      env
    });
    console.log(renderGlobalInstallResult(result));
    return;
  }

  if (command === 'doctor') {
    console.log(renderDoctor({ workspaceRoot, packageRoot, manager, sessionId }));
    return;
  }

  if (command === 'snapshot') {
    const result = manager.snapshot({ workspaceRoot, sessionId, write: false });
    console.log(result.markdown);
    return;
  }

  if (command === 'review-project') {
    const review = reviewProjectContext({ workspaceRoot, maxFiles: Number(flags.maxFiles || 30) });
    if (!review.unchanged) {
      manager.upsertMemory({ workspaceRoot, kind: 'project_overview', title: 'Project overview cache', body: review.summary, tags: ['project-overview', 'manual-review'], source: { fingerprint: review.fingerprint } });
    }
    console.log(review.summary);
    return;
  }

  if (command === 'clear-current') {
    const result = manager.clearCurrent({ workspaceRoot, sessionId, deleteFiles: Boolean(flags.deleteFiles) });
    console.log(result.markdown);
    return;
  }

  if (command === 'cleanup') {
    const result = manager.cleanupWorkspace({
      workspaceRoot,
      minAgeMs: flags.minAgeMs === undefined ? undefined : Number(flags.minAgeMs),
      scratchMaxAgeMs: flags.scratchMaxAgeMs === undefined ? undefined : Number(flags.scratchMaxAgeMs)
    });
    console.log(result.markdown);
    return;
  }

  if (command === 'prune-history') {
    const result = manager.pruneHistory({
      workspaceRoot,
      retentionDays: flags.retentionDays === undefined ? undefined : Number(flags.retentionDays),
      dryRun: Boolean(flags.dryRun)
    });
    console.log(result.markdown);
    return;
  }

  if (command === 'hook') {
    const eventName = argv[1];
    await runHookScript(eventName, { stdin, cwd: workspaceRoot, env });
    return;
  }

  if (command === 'mcp-config') {
    console.log(renderMcpConfig(packageRoot));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseFlags(items) {
  const flags = {};
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item?.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = items[i + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return flags;
}

function renderDoctor({ workspaceRoot, packageRoot, manager, sessionId }) {
  const active = manager.snapshot({ workspaceRoot, sessionId, write: false }).run;
  const current = readJson(currentJsonPath(workspaceRoot, sessionId), null);
  const index = readJson(currentJsonPath(workspaceRoot), null);
  const lines = [];
  lines.push('## Overtli Task Manager doctor');
  lines.push('');
  lines.push(`Workspace: \`${workspaceRoot}\``);
  lines.push(`Package: \`${packageRoot}\``);
  lines.push(`Storage: \`${manager.store.kind}\``);
  lines.push(`Session: \`${sessionId || 'unscoped'}\``);
  lines.push(`Active route for session: ${active ? `yes — ${active.id}` : 'no'}`);
  lines.push(`Session current.json: ${current ? 'present' : 'not present'}`);
  lines.push(`Active workspace sessions: ${index?.activeSessionCount ?? manager.store.listActiveRuns(workspaceRoot).length}`);
  const overridePath = path.join(workspaceRoot, 'AGENTS.override.md');
  if (pathExists(overridePath) && readText(overridePath, '').trim()) {
    lines.push('AGENTS override: present; `otm install` patches root `AGENTS.md` by default. Use `--agents-file AGENTS.override.md` only when you explicitly want to patch the override file.');
  }
  lines.push('');
  lines.push('Run `otm install` from the target repository to patch AGENTS.md, repo skills, hooks, and gitignore idempotently. Add `--with-project-mcp-config` only when you want a project-scoped MCP config block.');
  return `${lines.join('\n')}\n`;
}

function renderMcpConfig(packageRoot) {
  const mcpPath = path.join(packageRoot, 'bin', 'otm-mcp.mjs').replace(/\\/g, '\\\\');
  return `[mcp_servers.overtli_task_manager]
command = "node"
args = ["${mcpPath}"]
enabled = true
tool_timeout_sec = 45
startup_timeout_sec = 20

[mcp_servers.overtli_task_manager.env]
OTM_STORAGE = "auto"
`;
}

function helpText() {
  return `Overtli Task Manager

Commands:
  otm install [--workspace PATH] [--dry-run] [--with-project-mcp-config] [--agents-file AGENTS.override.md]
  otm install-global [--codex-home PATH] [--dry-run]
  otm doctor [--workspace PATH] [--session-id ID]
  otm snapshot [--workspace PATH] [--session-id ID]
  otm review-project [--workspace PATH] [--max-files N]
  otm clear-current [--workspace PATH] [--session-id ID] [--delete-files]
  otm cleanup [--workspace PATH] [--min-age-ms N] [--scratch-max-age-ms N]
  otm prune-history [--workspace PATH] [--retention-days N] [--dry-run]
  otm mcp-config

MCP server:
  otm-mcp
`;
}
