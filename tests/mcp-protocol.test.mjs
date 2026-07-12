import './support/temp-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { toMcpResult } from '../src/mcp/result.mjs';
import { tools as mcpTools } from '../src/mcp/tools.mjs';
import { parseScopedResourceUri, validateMcpArgs } from '../src/mcp/server.mjs';

function tempWorkspace(prefix = 'otm-mcp-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

test('MCP results provide Markdown and a redacted structured envelope', () => {
  const result = toMcpResult({ markdown: '## OTM\n\nPlain progress.\n', snapshot: { noisy: true }, authorization: 'Bearer secret-value' });
  assert.deepEqual(Object.keys(result), ['content', 'structuredContent']);
  assert.equal(result.content[0].text, '## OTM\n\nPlain progress.\n');
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.result.authorization, '[REDACTED]');
  const fallback = toMcpResult({ stopAllowed: false, remainingRequired: [{ title: 'Finish tests' }] });
  assert.match(fallback.content[0].text, /audit blocked/i);
  assert.doesNotMatch(fallback.content[0].text, /remainingRequired/);
  assert.deepEqual(fallback.structuredContent.result.remainingRequired, [{ title: 'Finish tests' }]);
});

test('MCP schemas close input/output objects and reject nested unsafe arguments', () => {
  assert.ok(mcpTools.length > 0);
  for (const tool of mcpTools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.outputSchema.type, 'object', tool.name);
    assert.equal(tool.outputSchema.additionalProperties, false, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    for (const [field, schema] of Object.entries(tool.inputSchema.properties || {})) {
      if (schema.type === 'string') assert.ok(schema.maxLength, `${tool.name}.${field} must declare maxLength`);
      if (schema.type === 'array') assert.ok(schema.maxItems, `${tool.name}.${field} must declare maxItems`);
    }
  }
  assert.equal(mcpTools.find((tool) => tool.name === 'otm_snapshot').annotations.readOnlyHint, true);
  assert.equal(mcpTools.find((tool) => tool.name === 'otm_memory_delete').annotations.destructiveHint, true);
  assert.equal(mcpTools.find((tool) => tool.name === 'otm_abandon').annotations.destructiveHint, true);
  assert.throws(() => validateMcpArgs('otm_snapshot', { unknown: true }), { code: 'MCP_UNKNOWN_ARGUMENT' });
  assert.throws(() => validateMcpArgs('otm_start', { goal: 'x'.repeat(16_001) }), { code: 'INPUT_TOO_LARGE' });
  const cyclic = {}; cyclic.context = cyclic;
  assert.throws(() => validateMcpArgs('otm_start', { goal: 'valid', context: cyclic }), { code: 'CYCLIC_CONTEXT' });
  assert.throws(() => validateMcpArgs('otm_start', { goal: 'valid', tasks: [{ title: 'nested', unexpected: true }] }), { code: 'MCP_UNKNOWN_ARGUMENT' });
  assert.throws(() => validateMcpArgs('otm_complete_task', { taskId: 'task', evidence: { summary: 'x', leaked: true } }), { code: 'MCP_UNKNOWN_ARGUMENT' });
  assert.throws(() => validateMcpArgs('otm_reconcile', { changes: Array.from({ length: 257 }, () => ({ action: 'add', title: 'task' })) }), { code: 'INPUT_TOO_LARGE' });
  assert.throws(() => validateMcpArgs('otm_cleanup_workspace', { minAgeMs: -1 }), { code: 'MCP_INVALID_ARGUMENTS' });
  assert.throws(() => validateMcpArgs('otm_progress', { message: 'ok', internalStepIndex: 1.5 }), { code: 'MCP_INVALID_ARGUMENTS' });
  assert.throws(() => validateMcpArgs('otm_complete_task', { taskId: 'task', evidence: { summary: 'ok', exitCode: 256 } }), { code: 'MCP_INVALID_ARGUMENTS' });
  assert.throws(() => validateMcpArgs('otm_abandon', { runId: 'run' }), { code: 'MCP_INVALID_ARGUMENTS' });
});

test('MCP resource URI scope is explicit and safe', () => {
  assert.deepEqual(parseScopedResourceUri('otm://workspace/C%3A%5CWork%5CProject/session/thread-42/current.md'), { workspace: 'C:\\Work\\Project', sessionId: 'thread-42', markdown: true });
  assert.equal(parseScopedResourceUri('otm://current'), null);
  assert.throws(() => parseScopedResourceUri('otm://workspace/%E0%A4/session/x/current'), { code: 'MCP_RESOURCE_URI_INVALID' });
});

test('MCP stdio protocol rejects malformed arguments and returns scoped structured results', async () => {
  const workspaceRoot = tempWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-mcp-protocol-state-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const client = new Client({ name: 'otm-protocol-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageRoot, 'bin', 'otm-mcp.mjs')],
    cwd: workspaceRoot,
    env: { OTM_STORAGE: 'json', OTM_STATE_DIR: stateDir, CODEX_THREAD_ID: 'mcp-protocol-session' },
    stderr: 'pipe'
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'otm_resume'));
    assert.equal(listed.tools.find((tool) => tool.name === 'otm_archive').annotations.destructiveHint, true);
    const malformed = await client.callTool({ name: 'otm_snapshot', arguments: { unexpected: true } });
    assert.equal(malformed.isError, true);
    assert.equal(malformed.structuredContent.code, 'MCP_UNKNOWN_ARGUMENT');
    const doctor = await client.callTool({ name: 'otm_doctor', arguments: { workspaceRoot } });
    assert.equal(doctor.structuredContent.ok, true);
    assert.equal(doctor.structuredContent.result.report.storage, 'json');
    assert.equal(fs.readdirSync(stateDir).length, 0, 'MCP doctor must not initialize storage');
    const started = await client.callTool({ name: 'otm_start', arguments: { workspaceRoot, goal: 'Protocol start', tasks: [{ title: 'Protocol task' }] } });
    assert.equal(started.structuredContent.ok, true);
    const scopedUri = `otm://workspace/${encodeURIComponent(workspaceRoot)}/session/mcp-protocol-session/current`;
    const resource = await client.readResource({ uri: scopedUri });
    assert.equal(JSON.parse(resource.contents[0].text).sessionId, 'mcp-protocol-session');
  } finally { await client.close(); }
});
