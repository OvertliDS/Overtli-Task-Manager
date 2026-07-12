#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";

const logPath = new URL("../ci-test.log", import.meta.url);
const log = fs.createWriteStream(logPath, { encoding: "utf8" });
const child = spawn(process.execPath, ["--test"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

/**
 * @param {NodeJS.ReadableStream} stream
 * @param {NodeJS.WritableStream} destination
 */
function tee(stream, destination) {
  stream.on("data", (chunk) => {
    destination.write(chunk);
    log.write(chunk);
  });
}

tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

child.on("error", (error) => {
  const message = `${error?.stack || error}
`;
  process.stderr.write(message);
  log.end(message, () => process.exit(1));
});

child.on("close", (code, signal) => {
  const result = `
[ci-test] exitCode=${code ?? "null"} signal=${signal ?? "none"}
`;
  process.stdout.write(result);
  log.end(result, () => process.exit(code ?? 1));
});
