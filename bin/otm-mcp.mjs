#!/usr/bin/env node
import { runMcpServer } from '../src/mcp/server.mjs';
import { redactSensitiveText } from '../src/core/validation.mjs';

runMcpServer().catch((error) => {
  // MCP transports are often supervised and surface stderr to users. Keep
  // diagnostics useful without exposing a stack trace or credential-shaped
  // values from an upstream error.
  console.error(`[Overtli Task Manager] MCP server failed: ${redactSensitiveText(error?.message || error)}`);
  process.exit(1);
});
