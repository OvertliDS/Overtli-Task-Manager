import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("declared package exports are importable through the package name", () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { createTaskManager } from '@overtli/task-manager'; import * as mcp from '@overtli/task-manager/mcp'; import * as hooks from '@overtli/task-manager/hooks'; if (typeof createTaskManager !== 'function' || typeof mcp.runMcpServer !== 'function' || typeof hooks.runHookScript !== 'function') process.exit(2);",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stderr || result.stdout}`);
});

test("SQLite backend is a required dependency, not an optional test lane", () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(typeof manifest.dependencies?.["better-sqlite3"], "string");
  assert.equal(
    Object.hasOwn(manifest.optionalDependencies || {}, "better-sqlite3"),
    false,
  );
});
