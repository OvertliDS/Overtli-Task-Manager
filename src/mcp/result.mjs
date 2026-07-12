export function toMcpResult(result) {
  return {
    content: [{ type: 'text', text: result?.markdown || renderPlainResult(result) }],
    // MCP clients that understand structuredContent receive a machine-safe
    // companion payload with a stable envelope; Markdown remains the
    // human-facing representation and arbitrary operation fields stay inside
    // `result` rather than leaking into the protocol root.
    structuredContent: { ok: true, result: sanitizeStructuredResult(result) }
  };
}

function sanitizeStructuredResult(value) {
  if (value === undefined) return { ok: true };
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/authorization|token|secret|password|private.?key/i.test(key)) return '[REDACTED]';
    return item;
  }));
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
