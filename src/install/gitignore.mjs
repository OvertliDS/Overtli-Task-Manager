import path from 'node:path';
import { readText, atomicWriteText } from '../core/fs-utils.mjs';

const BLOCK_BEGIN = '# OVERTLI-TASK-MANAGER:GITIGNORE:BEGIN v1';
const BLOCK_END = '# OVERTLI-TASK-MANAGER:GITIGNORE:END';

export function patchGitignore({ workspaceRoot, dryRun = false } = {}) {
  const filePath = path.join(workspaceRoot, '.gitignore');
  const before = readText(filePath, '');
  if (markerCount(before, BLOCK_BEGIN) > 1 || markerCount(before, BLOCK_END) > 1) {
    return { ok: false, action: 'conflict', filePath, reason: 'Gitignore contains duplicate OTM managed block markers.' };
  }
  const block = `${BLOCK_BEGIN}
.codex/overtli-task-manager/current.json
.codex/overtli-task-manager/current.md
.codex/overtli-task-manager/sessions/
.codex/overtli-task-manager/summaries/
.codex/overtli-task-manager/cache/
.codex/overtli-task-manager/*.tmp
.codex/overtli-task-manager/install.json
.codex/overtli-task-manager/*.sqlite*
${BLOCK_END}`;
  const begin = before.indexOf(BLOCK_BEGIN);
  const end = before.indexOf(BLOCK_END);
  let after;
  if (begin >= 0 && end >= 0 && end > begin) {
    after = `${before.slice(0, begin).trimEnd()}\n\n${block}\n${before.slice(end + BLOCK_END.length).trimStart()}`.trimEnd() + '\n';
  } else if (begin >= 0 || end >= 0) {
    return { ok: false, action: 'conflict', filePath, reason: 'Gitignore managed block markers are incomplete.' };
  } else {
    after = `${before.trimEnd()}\n\n${block}\n`.trimStart();
  }
  if (!dryRun && after !== before) atomicWriteText(filePath, after);
  return { ok: true, filePath, dryRun, action: after === before ? 'unchanged' : 'updated', changed: after !== before, preview: dryRun ? after : undefined };
}

function markerCount(text, marker) {
  return String(text).split(marker).length - 1;
}
