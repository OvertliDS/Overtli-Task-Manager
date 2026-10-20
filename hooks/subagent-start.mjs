#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runHookScript } from "../src/hooks/runner.mjs";

function readStdin() {
  try {
    return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

runHookScript("subagent-start", {
  stdin: readStdin(),
  cwd: process.cwd(),
  env: process.env,
}).catch((error) => {
  process.stdout.write(
    JSON.stringify({
      continue: true,
      suppressOutput: true,
      systemMessage: `OTM hook warning: ${error?.message || error}`,
    }) + "\n",
  );
});
