import path from "node:path";
import { readText, atomicWriteText } from "../core/fs-utils.mjs";
import { MCP_BLOCK_BEGIN, MCP_BLOCK_END } from "../core/constants.mjs";

/** @param {any} options */
export function patchProjectMcpConfig(options = {}) {
  const { workspaceRoot, packageRoot, dryRun = false } = options;
  const filePath = path.join(workspaceRoot, ".codex", "config.toml");
  const before = readText(filePath, "");
  if (
    markerCount(before, MCP_BLOCK_BEGIN) > 1 ||
    markerCount(before, MCP_BLOCK_END) > 1
  ) {
    return {
      ok: false,
      action: "conflict",
      filePath,
      reason: "MCP configuration contains duplicate OTM managed block markers.",
    };
  }
  const commandPath = path
    .join(packageRoot, "bin", "otm-mcp.mjs")
    .replace(/\\/g, "\\\\");
  const block = `${MCP_BLOCK_BEGIN}
[mcp_servers.overtli_task_manager]
command = "node"
args = ["${commandPath}"]
enabled = true
tool_timeout_sec = 45
startup_timeout_sec = 20

[mcp_servers.overtli_task_manager.env]
OTM_STORAGE = "auto"
${MCP_BLOCK_END}`;
  const begin = before.indexOf(MCP_BLOCK_BEGIN);
  const end = before.indexOf(MCP_BLOCK_END);
  if (begin >= 0 !== end >= 0) {
    return {
      ok: false,
      action: "conflict",
      filePath,
      reason: "MCP managed block markers are incomplete.",
    };
  }
  if (begin < 0 && /\[mcp_servers\.overtli_task_manager\]/.test(before)) {
    return {
      ok: false,
      action: "conflict",
      filePath,
      reason:
        "An unmanaged overtli_task_manager MCP server already exists in config.toml.",
    };
  }
  const after =
    begin >= 0
      ? `${before.slice(0, begin).trimEnd()}\n\n${block}\n${before.slice(end + MCP_BLOCK_END.length).trimStart()}`.trimEnd() +
        "\n"
      : `${before.trimEnd()}\n\n${block}\n`.trimStart();
  if (!dryRun && after !== before) atomicWriteText(filePath, after);
  return {
    ok: true,
    filePath,
    dryRun,
    changed: after !== before,
    preview: dryRun ? after : undefined,
  };
}

function markerCount(text, marker) {
  return String(text).split(marker).length - 1;
}
