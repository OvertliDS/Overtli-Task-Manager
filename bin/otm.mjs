#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { handleCli } from '../src/cli/commands.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readStdinIfAvailable() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

handleCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdin: readStdinIfAvailable(),
  packageRoot,
  env: process.env
}).catch((error) => {
  console.error(`[Overtli Task Manager] ${error?.stack || error?.message || error}`);
  process.exit(1);
});
