import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createTaskManager } from '../core/manager.mjs';
import { findWorkspaceRoot, currentJsonPath, currentMarkdownPath, readText, readOtmJsonArtifact } from '../core/fs-utils.mjs';
import { installWorkspace, renderInstallResult } from '../install/install-workspace.mjs';
import { reviewProjectContext } from '../context/project-review.mjs';
import { tools } from './tools.mjs';
import { toMcpResult } from './result.mjs';
import { resolveSessionId } from '../core/session-scope.mjs';
import { assertAcyclicContext } from '../core/validation.mjs';
import { OtmError } from '../core/errors.mjs';
import { VERSION } from '../core/constants.mjs';
import { canonicalizeWorkspaceRoot } from '../core/validation.mjs';
import { inspectDoctor, renderDoctor } from '../cli/doctor.mjs';

export async function runMcpServer({ env = process.env } = {}) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let manager = null;
  const getManager = () => manager || (manager = createTaskManager({ env }));
  const server = new Server(
    { name: 'overtli_task_manager', version: VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: 'Overtli Task Manager keeps Codex work organized as route checklists and automatically isolates routes by workspace plus CODEX_THREAD_ID. Before otm_start/otm_reconcile, thoroughly analyze the full user request and pass specific route segments with internalSteps. Before task-scoped OTM calls, use exact task ids from the latest snapshot or its session-scoped current.json; never copy ids from another chat, the workspace index, memory, or prior route state. Use otm_progress to mark internal steps complete as work happens, use otm_complete_task only after internal steps are terminal and segment-level evidence exists, call otm_audit_stop before final answers, then call otm_finalize_turn, show its Markdown summary, and call otm_clear_current.'
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const name = request.params.name;
      const args = request.params.arguments || {};
      validateMcpArgs(name, args);
      // Doctor must be able to diagnose malformed storage without normal store
      // initialization quarantining or rewriting it.
      const result = await dispatchTool({ name, args, manager: name === 'otm_doctor' ? null : getManager(), packageRoot, env });
      return toMcpResult(result);
    } catch (error) {
      const code = error?.code || 'OTM_INTERNAL_ERROR';
      return {
        isError: true,
        content: [{ type: 'text', text: `OTM ${code}: ${error?.message || 'Operation failed.'}` }],
        structuredContent: { ok: false, code, details: sanitizeErrorDetails(error?.details) }
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'otm://current', name: 'OTM current JSON', mimeType: 'application/json', description: 'Active OTM route state for the current workspace and Codex session.' },
      { uri: 'otm://current.md', name: 'OTM current Markdown', mimeType: 'text/markdown', description: 'Chat-friendly OTM route state for the current workspace and Codex session.' },
      { uri: 'otm://project-review', name: 'OTM project review', mimeType: 'text/markdown', description: 'Lightweight project awareness cache.' }
    ]
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: 'otm://workspace/{workspace}/session/{session}/current', name: 'Scoped OTM current JSON', mimeType: 'application/json', description: 'Current JSON for an explicitly encoded absolute workspace and session.' },
      { uriTemplate: 'otm://workspace/{workspace}/session/{session}/current.md', name: 'Scoped OTM current Markdown', mimeType: 'text/markdown', description: 'Current Markdown for an explicitly encoded absolute workspace and session.' }
    ]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const scoped = parseScopedResourceUri(request.params.uri);
    if (scoped) {
      const workspaceRoot = canonicalizeWorkspaceRoot(scoped.workspace).displayPath;
      const filePath = scoped.markdown ? currentMarkdownPath(workspaceRoot, scoped.sessionId) : currentJsonPath(workspaceRoot, scoped.sessionId);
      const text = scoped.markdown
        ? readText(filePath, 'No active OTM route for this Codex session.\n')
        : JSON.stringify(readOtmJsonArtifact(filePath) || {}, null, 2);
      return { contents: [{ uri: request.params.uri, mimeType: scoped.markdown ? 'text/markdown' : 'application/json', text }] };
    }
    const workspaceRoot = findWorkspaceRoot(process.cwd());
    const sessionId = resolveSessionId({}, env);
    if (request.params.uri === 'otm://current') {
      return { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: JSON.stringify(readOtmJsonArtifact(currentJsonPath(workspaceRoot, sessionId)) || {}, null, 2) }] };
    }
    if (request.params.uri === 'otm://current.md') {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: readText(currentMarkdownPath(workspaceRoot, sessionId), 'No active OTM route for this Codex session.\n') }] };
    }
    if (request.params.uri === 'otm://project-review') {
      const review = reviewProjectContext({ workspaceRoot });
      return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: review.summary }] };
    }
    throw new Error(`Unknown OTM resource: ${request.params.uri}`);
  });

  const transport = new StdioServerTransport();
  let closed = false;
  const closeStore = () => {
    if (closed) return;
    closed = true;
    try { manager?.close?.(); } catch {}
  };
  process.once('SIGINT', closeStore);
  process.once('SIGTERM', closeStore);
  await server.connect(transport);
}

export function parseScopedResourceUri(uri) {
  const match = /^otm:\/\/workspace\/([^/]+)\/session\/([^/]+)\/(current(?:\.md)?)$/.exec(String(uri || ''));
  if (!match) return null;
  try {
    return { workspace: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]), markdown: match[3] === 'current.md' };
  } catch {
    throw new OtmError('Invalid percent encoding in scoped OTM resource URI.', { code: 'MCP_RESOURCE_URI_INVALID' });
  }
}

function sanitizeErrorDetails(value) {
  if (!value || typeof value !== 'object') return undefined;
  return JSON.parse(JSON.stringify(value, (key, item) => /authorization|token|secret|password|private.?key/i.test(key) ? '[REDACTED]' : item));
}

export function validateMcpArgs(name, args) {
  const definition = tools.find((tool) => tool.name === name);
  if (!definition) throw new OtmError(`Unknown tool: ${name}`, { code: 'MCP_TOOL_UNKNOWN' });
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new OtmError('MCP tool arguments must be an object.', { code: 'MCP_INVALID_ARGUMENTS' });
  const allowed = new Set(Object.keys(definition.inputSchema?.properties || {}));
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) throw new OtmError('MCP arguments include unsupported properties.', { code: 'MCP_UNKNOWN_ARGUMENT', details: { fields: unknown } });
  assertAcyclicContext(args);
  // A conservative top-level budget remains in force for legacy/simple tool
  // schemas; richer nested schemas below impose tighter field-specific bounds.
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 16_000) throw sizeError(`arguments.${key}`, 16_000, 'string');
    if (Array.isArray(value) && value.length > 256) throw sizeError(`arguments.${key}`, 256, 'array');
  }
  validateSchemaValue(args, definition.inputSchema, 'arguments');
}

function validateSchemaValue(value, schema = {}, field) {
  if (!schema || Object.keys(schema).length === 0) return;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      try { validateSchemaValue(value, candidate, field); return true; } catch { return false; }
    });
    if (matches.length === 1) return;
    throw schemaError(field, 'does not match exactly one allowed shape');
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw schemaError(field, 'must be an object');
    const properties = schema.properties || {};
    for (const required of schema.required || []) if (value[required] === undefined) throw schemaError(`${field}.${required}`, 'is required');
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).filter((key) => !Object.hasOwn(properties, key));
      if (unknown.length) throw new OtmError('MCP nested arguments include unsupported properties.', { code: 'MCP_UNKNOWN_ARGUMENT', details: { fields: unknown.map((key) => `${field}.${key}`) } });
    }
    for (const [key, child] of Object.entries(value)) if (Object.hasOwn(properties, key)) validateSchemaValue(child, properties[key], `${field}.${key}`);
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw schemaError(field, 'must be an array');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw sizeError(field, schema.maxItems, 'array');
    for (const [index, item] of value.entries()) validateSchemaValue(item, schema.items || {}, `${field}[${index}]`);
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw schemaError(field, 'must be a string');
    if (schema.minLength !== undefined && value.length < schema.minLength) throw schemaError(field, `must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw sizeError(field, schema.maxLength, 'string');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw schemaError(field, 'must be a boolean');
  else if (schema.type === 'integer' && (!Number.isInteger(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw schemaError(field, 'must be an integer in range');
  else if (schema.type === 'number' && (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw schemaError(field, 'must be a number in range');
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw schemaError(field, 'has an unsupported value');
}

function schemaError(field, reason) { return new OtmError(`MCP argument ${field} ${reason}.`, { code: 'MCP_INVALID_ARGUMENTS', details: { field, reason } }); }
function sizeError(field, maximum, type) { return new OtmError(`MCP ${type} argument exceeds the maximum size.`, { code: 'INPUT_TOO_LARGE', details: { field, maximum } }); }

async function dispatchTool({ name, args, manager, packageRoot, env }) {
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
    case 'otm_abandon': return manager.abandonRun(args);
    case 'otm_resume': return manager.resumeRun(args);
    case 'otm_archive': return manager.archiveRun(args);
    case 'otm_cleanup_workspace': return manager.cleanupWorkspace(args);
    case 'otm_prune_history': return manager.pruneHistory(args);
    case 'otm_memory_search': return memorySearchResult(manager.searchMemory(args));
    case 'otm_memory_upsert': return { ...manager.upsertMemory(args), markdown: `## ✅ OTM memory updated\n\nSaved: **${args.title}**\n` };
    case 'otm_memory_delete': return { ...manager.deleteMemory(args), markdown: '## ✅ OTM memory cleanup\n\nRequested memory entries were removed when matched.\n' };
    case 'otm_memory_list': return memorySearchResult(manager.listMemory(args));
    case 'otm_memory_inspect': {
      const inspected = manager.inspectMemory(args);
      return { ...inspected, markdown: `## OTM memory\n\n${inspected.entry.title}\n` };
    }
    case 'otm_memory_purge_expired': return { ...manager.purgeExpiredMemory(args), markdown: '## OTM expired memory purge\n\nExpired memory entries were evaluated.\n' };
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
      const sessionId = resolveSessionId(args, env);
      const report = inspectDoctor({ workspaceRoot, packageRoot, sessionId, env });
      return { report, markdown: renderDoctor(report) };
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
