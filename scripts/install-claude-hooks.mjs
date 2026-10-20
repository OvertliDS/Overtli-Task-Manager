#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installClaudeHooks,
  rollbackClaudeHooks,
} from "../src/install/claude-settings.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = parseArgs(process.argv.slice(2));
const result = args.rollback
  ? rollbackClaudeHooks({
      backupPath: args.backup,
      backupHash: args["backup-hash"],
      expectedCurrentHash: args["expected-current-hash"],
      removeCreatedSettings: args["remove-created-settings"] === "true",
    })
  : installClaudeHooks({
      packageRoot,
      dryRun: args["dry-run"] === true,
      expectedCurrentHash: args["expected-current-hash"],
      hostEvidenceModulePath: args["host-evidence-module"],
      stateDir: args["state-dir"],
      storage: args.storage,
    });

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.ok === false) process.exitCode = 1;

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dry-run") parsed["dry-run"] = true;
    else if (value === "--rollback") parsed.rollback = true;
    else if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = values[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${value}.`);
      }
      parsed[key] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}
