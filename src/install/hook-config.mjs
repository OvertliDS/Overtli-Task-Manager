import fs from 'node:fs';
import path from 'node:path';
import { readJson, readText, atomicWriteText } from '../core/fs-utils.mjs';

const EVENT_COMMANDS = {
  SessionStart: { matcher: 'startup|resume|compact', statusMessage: 'Loading OTM route', event: 'session-start' },
  UserPromptSubmit: { statusMessage: 'Mapping prompt to OTM route', event: 'user-prompt-submit' },
  PreToolUse: { matcher: 'Bash|apply_patch|mcp__.*', statusMessage: 'Checking OTM route', event: 'pre-tool-use' },
  PostToolUse: { matcher: 'Bash|apply_patch|mcp__.*', statusMessage: 'Recording OTM evidence', event: 'post-tool-use' },
  PreCompact: { matcher: 'manual|auto', statusMessage: 'Saving OTM route', event: 'pre-compact' },
  PostCompact: { matcher: 'manual|auto', statusMessage: 'Restoring OTM route', event: 'post-compact' },
  Stop: { statusMessage: 'Auditing OTM completion', event: 'stop', timeout: 30 }
};

export function patchHooksJson({ workspaceRoot, packageRoot, dryRun = false } = {}) {
  const filePath = path.join(workspaceRoot, '.codex', 'hooks.json');
  const doc = readJson(filePath, { hooks: {} }) || { hooks: {} };
  if (!doc.hooks || typeof doc.hooks !== 'object') doc.hooks = {};
  for (const [eventName, spec] of Object.entries(EVENT_COMMANDS)) {
    const command = `node ${JSON.stringify(path.join(packageRoot, 'bin', 'otm.mjs'))} hook ${spec.event}`;
    const entry = {
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: 'command', command, ...(spec.timeout ? { timeout: spec.timeout } : {}), statusMessage: spec.statusMessage }]
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

function entryHasOtmCommand(entry) {
  const text = JSON.stringify(entry || {}).toLowerCase();
  return text.includes('overtli-task-manager') || (text.includes('otm.mjs') && text.includes(' hook '));
}
