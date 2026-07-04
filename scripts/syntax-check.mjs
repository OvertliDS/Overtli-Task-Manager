#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const skipDirs = new Set(['node_modules', '.git', '.codex']);
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(join(dir, entry.name));
    }
  }
}

walk(root);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    console.error(result.stderr || result.stdout);
  }
}
if (failed) process.exit(1);
console.log(`Syntax check passed for ${files.length} module(s).`);
