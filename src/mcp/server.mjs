import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createTaskManager } from '../core/manager.mjs';
import { findWorkspaceRoot, currentJsonPath, currentMarkdownPath, readText, readJson } from '../core/fs-utils.mjs';
import { installWorkspace, renderInstallResult } from '../install/install-workspace.mjs';
import { reviewProjectContext } from '../context/project-review.mjs';
import { tools } from './tools.mjs';
import { toMcpResult } from './result.mjs';

export async function runMcpServer({ env = process.env } = {}) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manager = createTaskManager({ env });
  const server = new Server(
    { name: 'overtli_task_manager', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: 'Overtli Task Manager keeps Codex work organized as route checklists. Before otm_start/otm_reconcile, thoroughly analyze the full user request and pass specific route segments with internalSteps. Use otm_progress to mark internal steps complete as work happens, use otm_complete_task only after internal steps are terminal and segment-level evidence exists, call otm_audit_stop before final answers, then call otm_finalize_turn, show its Markdown summary, and call otm_clear_current.'
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    const result = await dispatchTool({ name, args, manager, packageRoot });
    return toMcpResult(result);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'otm://current', name: 'OTM current JSON', mimeType: 'application/json', description: 'Active OTM route state for the current workspace.' },
      { uri: 'otm://current.md', name: 'OTM current Markdown', mimeType: 'text/markdown', description: 'Chat-friendly OTM route state for the current workspace.' },
      { uri: 'otm://project-review', name: 'OTM project review', mimeType: 'text/markdown', description: 'Lightweight project awareness cache.' }
    ]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const workspaceRoot = findWorkspaceRoot(process.cwd());
    if (request.params.uri === 'otm://current') {
      return { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: JSON.stringify(readJson(currentJsonPath(workspaceRoot), null) || {}, null, 2) }] };
    }
    if (request.params.uri === 'otm://current.md') {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: readText(currentMarkdownPath(workspaceRoot), 'No active OTM route.\n') }] };
    }
    if (request.params.uri === 'otm://project-review') {
      const review = reviewProjectContext({ workspaceRoot });
      return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: review.summary }] };
    }
    throw new Error(`Unknown OTM resource: ${request.params.uri}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function dispatchTool({ name, args, manager, packageRoot }) {
  switch (name) {
    case 'otm_start': return manager.start(args);
    case 'otm_reconcile': return manager.reconcile(args);
    case 'otm_snapshot': return manager.snapshot(args);
    case 'otm_start_task': return manager.markTaskActive(args);
    case 'otm_progress': return manager.progress(args);
    case 'otm_complete_task': return manager.completeTask(args);
    case 'otm_block_task': return manager.blockTask(args);
    case 'otm_drop_task': return manager.dropTask(args);
    case 'otm_audit_stop': return manager.auditStop(args);
    case 'otm_finalize_turn': return manager.finalizeTurn(args);
    case 'otm_clear_current': return manager.clearCurrent(args);
    case 'otm_cleanup_workspace': return manager.cleanupWorkspace(args);
    case 'otm_prune_history': return manager.pruneHistory(args);
    case 'otm_memory_search': return memorySearchResult(manager.searchMemory(args));
    case 'otm_memory_upsert': return { ...manager.upsertMemory(args), markdown: `## ✅ OTM memory updated\n\nSaved: **${args.title}**\n` };
    case 'otm_memory_delete': return { ...manager.deleteMemory(args), markdown: '## ✅ OTM memory cleanup\n\nRequested memory entries were removed when matched.\n' };
    case 'otm_project_review': {
      const review = reviewProjectContext(args);
      if (!review.unchanged) {
        manager.upsertMemory({ workspaceRoot: review.workspaceRoot, kind: 'project_overview', title: 'Project overview cache', body: review.summary, tags: ['project-overview'], source: { fingerprint: review.fingerprint, sourceCount: review.sourceCount } });
      }
      return { review, markdown: review.summary };
    }
    case 'otm_install_workspace': {
      const result = installWorkspace({ ...args, cwd: process.cwd(), packageRoot });
      return { result, markdown: renderInstallResult(result) };
    }
    case 'otm_doctor': {
      const workspaceRoot = args.workspaceRoot || findWorkspaceRoot(process.cwd());
      const snap = manager.snapshot({ workspaceRoot });
      return { snapshot: snap.snapshot, markdown: `## OTM doctor\n\nStorage: \`${manager.store.kind}\`\nActive route: ${snap.run ? `yes — ${snap.run.id}` : 'no'}\ncurrent.json: \`${currentJsonPath(workspaceRoot)}\`\n` };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function memorySearchResult(result) {
  const lines = ['## OTM memory search', ''];
  if (!result.entries.length) lines.push('No matching project memory entries found.');
  for (const entry of result.entries) {
    lines.push(`### ${entry.title}`);
    lines.push(`Kind: ${entry.kind} · Score: ${entry.score}`);
    lines.push('');
    lines.push(entry.body.length > 1200 ? `${entry.body.slice(0, 1200)}\n…` : entry.body);
    lines.push('');
  }
  return { ...result, markdown: lines.join('\n') };
}
