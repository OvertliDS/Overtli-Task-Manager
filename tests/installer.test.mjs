import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installWorkspace } from "../src/install/install-workspace.mjs";

function tempWorkspace(prefix = "otm-installer-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Test Workspace\n", "utf8");
  return root;
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("workspace installation dry-run creates no state directories or managed files", () => {
  const workspaceRoot = tempWorkspace("otm-install-dry-run-");
  const before = fs.readdirSync(workspaceRoot).sort();
  const result = installWorkspace({
    workspaceRoot,
    packageRoot,
    dryRun: true,
    installMcpConfig: true,
  });
  assert.equal(result.dryRun, true);
  assert.deepEqual(fs.readdirSync(workspaceRoot).sort(), before);
  assert.equal(fs.existsSync(path.join(workspaceRoot, ".codex")), false);
  assert.equal(fs.existsSync(path.join(workspaceRoot, ".agents")), false);
});

test("a late workspace installation failure rolls back every earlier managed file", () => {
  const workspaceRoot = tempWorkspace("otm-install-rollback-");
  // The MCP writer fails only after the earlier managed operations run,
  // exercising transaction rollback rather than a preflight rejection.
  fs.mkdirSync(path.join(workspaceRoot, ".codex", "config.toml"), {
    recursive: true,
  });
  const result = installWorkspace({
    workspaceRoot,
    packageRoot,
    installMcpConfig: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(fs.existsSync(path.join(workspaceRoot, "AGENTS.md")), false);
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, ".codex", "hooks.json")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, ".agents", "skills")),
    false,
  );
  assert.equal(fs.existsSync(path.join(workspaceRoot, ".gitignore")), false);
  assert.equal(
    fs
      .statSync(path.join(workspaceRoot, ".codex", "config.toml"))
      .isDirectory(),
    true,
  );
});

test("malformed hooks JSON blocks installation before any managed file is written", () => {
  const workspaceRoot = tempWorkspace("otm-install-invalid-hooks-");
  const hooksPath = path.join(workspaceRoot, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, "{not valid json", "utf8");
  const result = installWorkspace({ workspaceRoot, packageRoot });
  assert.equal(result.ok, false);
  assert.equal(
    result.results.find((item) => item.step === "hooks").errorCode,
    "HOOKS_JSON_INVALID",
  );
  assert.equal(fs.readFileSync(hooksPath, "utf8"), "{not valid json");
  assert.equal(fs.existsSync(path.join(workspaceRoot, "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(workspaceRoot, ".agents")), false);
  assert.equal(
    fs.existsSync(
      path.join(
        workspaceRoot,
        ".codex",
        "overtli-task-manager",
        "install.json",
      ),
    ),
    false,
  );
});

test("duplicate managed markers block installation before other managed files are written", () => {
  const workspaceRoot = tempWorkspace("otm-install-duplicate-markers-");
  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  fs.writeFileSync(
    agentsPath,
    "<!-- OVERTLI-TASK-MANAGER:BEGIN v1 -->\nfirst\n<!-- OVERTLI-TASK-MANAGER:END -->\n<!-- OVERTLI-TASK-MANAGER:BEGIN v1 -->\nsecond\n<!-- OVERTLI-TASK-MANAGER:END -->\n",
    "utf8",
  );
  const result = installWorkspace({ workspaceRoot, packageRoot });
  assert.equal(result.ok, false);
  assert.equal(
    result.results.find((item) => item.step === "agents").action,
    "conflict",
  );
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, ".codex", "hooks.json")),
    false,
  );
  assert.equal(fs.readFileSync(agentsPath, "utf8").includes("second"), true);
});
