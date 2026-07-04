export function toMcpResult(result) {
  return {
    content: [{ type: 'text', text: result?.markdown || renderPlainResult(result) }]
  };
}

function renderPlainResult(result) {
  if (!result) return 'OTM command completed.';
  if (Array.isArray(result.entries)) return `OTM memory search returned ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}.`;
  if (Array.isArray(result.runs)) return `OTM found ${result.runs.length} run${result.runs.length === 1 ? '' : 's'}.`;
  if (typeof result.deleted === 'number') return `OTM removed ${result.deleted} matching entr${result.deleted === 1 ? 'y' : 'ies'}.`;
  if (result.entry?.title) return `OTM memory updated: ${result.entry.title}`;
  if (result.cleared) return 'OTM active route cleared.';
  if (typeof result.stopAllowed === 'boolean') return result.stopAllowed ? 'OTM audit passed. Stop is allowed.' : 'OTM audit blocked. Required route segments remain open.';
  return 'OTM command completed.';
}
