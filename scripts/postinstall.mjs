#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobal, renderGlobalInstallResult } from '../src/install/install-global.mjs';

export function shouldAutoInstallGlobal({ packageRoot, codexHome, env = process.env } = {}) {
  if (env.OTM_AUTO_INSTALL_GLOBAL === '0' || env.CI) return false;
  if (env.OTM_AUTO_INSTALL_GLOBAL === '1') return true;
  const expected = path.resolve(codexHome, 'plugins', 'overtli-task-manager');
  return path.resolve(packageRoot) === expected;
}

export function runPostinstall({ packageRoot, env = process.env } = {}) {
  const codexHome = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  if (!shouldAutoInstallGlobal({ packageRoot, codexHome, env })) {
    return { installed: false, message: 'Skipping OTM global setup outside the active Codex plugin directory.' };
  }
  const result = installGlobal({ codexHome, packageRoot, env });
  return { installed: true, result, message: renderGlobalInstallResult(result) };
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const outcome = runPostinstall({ packageRoot });
  process.stdout.write(outcome.installed ? outcome.message : `${outcome.message}\n`);
}
