#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { handleCli } from "../src/cli/commands.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readStdinForHook() {
  try {
    if (process.stdin.isTTY) return "";
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

handleCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdin: process.argv[2] === "hook" ? readStdinForHook() : "",
  packageRoot,
  env: process.env,
})
  .then((result) => {
    if (Number.isInteger(result?.exitCode)) process.exitCode = result.exitCode;
  })
  .catch((error) => {
    console.error(
      `[Overtli Task Manager] ${error?.code ? `${error.code}: ` : ""}${error?.message || error}`,
    );
    process.exit(1);
  });
