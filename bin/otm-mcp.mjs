#!/usr/bin/env node
import { runMcpServer } from '../src/mcp/server.mjs';

runMcpServer().catch((error) => {
  console.error(`[Overtli Task Manager] MCP server failed: ${error?.stack || error?.message || error}`);
  process.exit(1);
});
