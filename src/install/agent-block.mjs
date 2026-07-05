import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END } from '../core/constants.mjs';
import { readText, atomicWriteText, pathExists } from '../core/fs-utils.mjs';

export function managedAgentsBlock() {
  return [
    AGENTS_BLOCK_BEGIN,
    '## Overtli Task Manager protocol',
    '',
    'For every non-trivial Codex task in this workspace:',
    '',
    '1. Start or reconcile an Overtli Task Manager route before editing files or running implementation commands.',
    '2. Keep `.codex/overtli-task-manager/current.json` current through the OTM MCP tools.',
    '3. Show modern Markdown progress snapshots in chat after route creation, steering changes, blocked work, validation, and finalization.',
    '4. Treat tasks as route segments: one active segment at a time unless the user explicitly requests parallel work.',
    '5. While working a route segment, mark each internal step complete with `otm_progress` as soon as that step has concrete evidence; do not wait until the end and backfill the internal checklist.',
    '6. Mark a segment done with `otm_complete_task` only after every required internal step is terminal (`done` or intentionally `skipped`) and segment-level evidence exists, such as changed files, command output, test results, document review, or user confirmation.',
    '7. If the user changes direction, reconcile the route immediately instead of continuing from stale assumptions.',
    '8. Before any final response, run the OTM stop audit. If required segments remain open, continue working instead of ending the turn.',
    '9. At completion, call `otm_finalize_turn`, show its Markdown summary to the user, then call `otm_clear_current`; the Stop hook is only a fallback guard, not the normal final-summary path.',
    '10. Prefer thorough completion over shallow progress. Do not introduce placeholder logic, intentionally incomplete code, or unverified assumptions unless the user explicitly requests a scaffold.',
    '',
    AGENTS_BLOCK_END
  ].join('\n');
}

export function chooseAgentsFile(workspaceRoot, explicitTarget = null) {
  if (explicitTarget) return path.resolve(workspaceRoot, explicitTarget);
  return path.join(workspaceRoot, 'AGENTS.md');
}

export function patchAgentsFile({ workspaceRoot, targetFile = null, dryRun = false } = {}) {
  const filePath = chooseAgentsFile(workspaceRoot, targetFile);
  const before = readText(filePath, '');
  const block = managedAgentsBlock();
  const begin = before.indexOf(AGENTS_BLOCK_BEGIN);
  const end = before.indexOf(AGENTS_BLOCK_END);
  let after;
  let action;

  if (begin >= 0 && end >= 0 && end > begin) {
    const blockEnd = end + AGENTS_BLOCK_END.length;
    after = `${before.slice(0, begin).trimEnd()}\n\n${block}\n${before.slice(blockEnd).trimStart()}`.trimEnd() + '\n';
    action = 'updated';
  } else if (begin >= 0 || end >= 0) {
    return { ok: false, action: 'conflict', filePath, reason: 'Found only one OTM marker. Manual repair is required before automatic patching.' };
  } else if (!before.trim()) {
    after = `# AGENTS.md\n\n${block}\n`;
    action = 'created';
  } else {
    after = `${before.trimEnd()}\n\n${block}\n`;
    action = 'appended';
  }

  if (!dryRun && after !== before) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteText(filePath, after);
  }
  return {
    ok: true,
    action: after === before ? 'unchanged' : action,
    filePath,
    dryRun,
    changed: after !== before,
    warning: agentsOverrideWarning(workspaceRoot, targetFile),
    preview: dryRun ? after : undefined
  };
}

function agentsOverrideWarning(workspaceRoot, explicitTarget = null) {
  const override = path.join(workspaceRoot, 'AGENTS.override.md');
  if (!pathExists(override) || !readText(override, '').trim()) return undefined;
  if (explicitTarget && path.resolve(workspaceRoot, explicitTarget) === override) return undefined;
  return 'AGENTS.override.md exists and was not patched. Run install with --agents-file AGENTS.override.md only when you explicitly want OTM to patch the override file.';
}
