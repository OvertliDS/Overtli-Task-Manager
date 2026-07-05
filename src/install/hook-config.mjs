import fs from 'node:fs';
import path from 'node:path';
import { readJson, readText, atomicWriteText } from '../core/fs-utils.mjs';

const EVENT_COMMANDS = {
  SessionStart: { matcher: 'startup|resume|compact', statusMessage: 'Loading OTM route', event: 'session-start', timeout: 15 },
  UserPromptSubmit: { statusMessage: 'Mapping route', event: 'user-prompt-submit', timeout: 12 },
  PreToolUse: { matcher: 'Bash|apply_patch', event: 'pre-tool-use', timeout: 8 },
  PostToolUse: { matcher: 'Bash|apply_patch', event: 'post-tool-use', timeout: 12 },
  PreCompact: { matcher: 'manual|auto', statusMessage: 'Saving route', event: 'pre-compact', timeout: 15 },
  PostCompact: { matcher: 'manual|auto', statusMessage: 'Restoring route', event: 'post-compact', timeout: 15 },
  Stop: { statusMessage: 'Auditing completion', event: 'stop', timeout: 45 }
};

export function patchHooksJson({ workspaceRoot, packageRoot, targetFile = null, dryRun = false } = {}) {
  const filePath = targetFile ? path.resolve(targetFile) : path.join(workspaceRoot, '.codex', 'hooks.json');
  const doc = readJson(filePath, { hooks: {} }) || { hooks: {} };
  if (!doc.hooks || typeof doc.hooks !== 'object') doc.hooks = {};
  for (const [eventName, spec] of Object.entries(EVENT_COMMANDS)) {
    const command = `node ${quoteCommandArg(path.join(packageRoot, 'bin', 'otm.mjs'))} hook ${spec.event}`;
    const entry = {
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: 'command', command, ...(spec.timeout ? { timeout: spec.timeout } : {}), ...(spec.statusMessage ? { statusMessage: spec.statusMessage } : {}) }]
    };
    const existing = Array.isArray(doc.hooks[eventName]) ? doc.hooks[eventName] : [];
    const filtered = existing.filter((item) => !entryHasOtmCommand(item));
    filtered.push(entry);
    doc.hooks[eventName] = filtered;
  }
  const after = `${JSON.stringify(doc, null, 2)}\n`;
  const before = readText(filePath, '');
  const changed = after !== before;
  if (!dryRun && changed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteText(filePath, after);
  }
  return { ok: true, filePath, dryRun, action: changed ? 'updated' : 'unchanged', changed, hooksInstalled: Object.keys(EVENT_COMMANDS), preview: dryRun ? doc : undefined };
}

function quoteCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function entryHasOtmCommand(entry) {
  const text = JSON.stringify(entry || {}).toLowerCase();
  return text.includes('overtli-task-manager') || (text.includes('otm.mjs') && text.includes(' hook '));
}
