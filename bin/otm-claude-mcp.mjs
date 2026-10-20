#!/usr/bin/env node
import { runClaudeMcpServer } from "../src/claude/mcp-server.mjs";

runClaudeMcpServer().catch((error) => {
  process.stderr.write(
    `Overtli Task Manager Claude MCP failed to start: ${error?.code || "OTM_INTERNAL_ERROR"} ${error?.message || String(error)}\n`,
  );
  process.exitCode = 1;
});
