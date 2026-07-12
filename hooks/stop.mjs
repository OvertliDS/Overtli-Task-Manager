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

runHookScript("stop", {
  stdin: readStdin(),
  cwd: process.cwd(),
  env: process.env,
}).catch((error) => {
  // Stop-hook failures must fail open. A blocking error response is replayed by
  // the host and can trap the model in an otherwise unbreakable feedback loop.
  process.stdout.write(
    JSON.stringify({
      continue: true,
      suppressOutput: true,
      systemMessage: `OTM Stop hook warning: ${error?.message || error}`,
    }) + "\n",
  );
});
