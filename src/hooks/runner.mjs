import { createTaskManager } from '../core/manager.mjs';
import { classifyPrompt } from '../core/planner.mjs';
import { findWorkspaceRoot } from '../core/fs-utils.mjs';
import { reviewProjectContext } from '../context/project-review.mjs';

export async function runHookScript(eventName, { stdin = '', cwd = process.cwd(), env = process.env } = {}) {
  const input = parseJson(stdin, {});
  const workspaceRoot = findWorkspaceRoot(input.cwd || cwd);
  const manager = createTaskManager({ cwd: workspaceRoot, env });

  switch (eventName) {
    case 'session-start':
      return emitJson(handleSessionStart(manager, input, workspaceRoot));
    case 'user-prompt-submit':
      return emitJson(handleUserPromptSubmit(manager, input, workspaceRoot));
    case 'pre-tool-use':
      return emitJson(handlePreToolUse(manager, input, workspaceRoot));
    case 'post-tool-use':
      return emitJson(handlePostToolUse(manager, input, workspaceRoot));
    case 'pre-compact':
      return emitJson(handlePreCompact(manager, input, workspaceRoot));
    case 'post-compact':
      return emitJson(handlePostCompact(manager, input, workspaceRoot));
    case 'stop':
      return emitJson(handleStop(manager, input, workspaceRoot));
    default:
      return emitJson({ continue: true, suppressOutput: true });
  }
}

function handleSessionStart(manager, input, workspaceRoot) {
  let projectReview = null;
  try {
    projectReview = reviewProjectContext({ workspaceRoot, maxFiles: Number(process.env.OTM_PROJECT_REVIEW_MAX_FILES || 20) });
    manager.upsertMemory({ workspaceRoot, kind: 'project_overview', title: 'Project overview cache', body: projectReview.summary, tags: ['project-overview', 'auto-review'], source: { fingerprint: projectReview.fingerprint, sourceCount: projectReview.sourceCount } });
  } catch {}
  const snap = manager.snapshot({ workspaceRoot, lastUpdate: { kind: 'session_start', message: 'Session loaded OTM state.', at: new Date().toISOString() } });
  const context = snap.run
    ? `Overtli Task Manager loaded an active route. Continue using OTM tools and keep current.json updated.\n\n${snap.markdown}`
    : `Overtli Task Manager is available. For non-trivial work, call otm_start or otm_reconcile before implementation. Project awareness cache ${projectReview ? 'was refreshed' : 'was not refreshed'}.`;
  return { continue: true, suppressOutput: true, systemMessage: context };
}

function handleUserPromptSubmit(manager, input, workspaceRoot) {
  const active = manager.snapshot({ workspaceRoot, write: false }).run;
  const classification = classifyPrompt(input.prompt || '', Boolean(active));
  if (classification === 'empty' || classification === 'simple') {
    return { continue: true, suppressOutput: true };
  }
  const action = active && ['continue', 'steer'].includes(classification) ? 'otm_reconcile' : 'otm_start';
  const additionalContext = [
    'Overtli Task Manager protocol is active for this turn.',
    `Prompt classification: ${classification}.`,
    `Before editing files or running implementation commands, call ${action} with workspaceRoot set to ${workspaceRoot}.`,
    'Show the returned Markdown checklist snapshot in chat.',
    'Keep exactly one active route segment when possible; mark completion only with concrete evidence.',
    'If the user steers, reconcile before continuing. Before final response, call otm_audit_stop. If required tasks remain, continue working.'
  ].join('\n');
  return { continue: true, suppressOutput: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } };
}

function handlePreToolUse(manager, input, workspaceRoot) {
  const current = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  if (!current?.runId || input.tool_name?.includes('overtli_task_manager')) return { continue: true, suppressOutput: true };
  if (process.env.OTM_RECORD_PRE_TOOL === '1') {
    const message = classifyToolIntent(input);
    if (message) {
      try { manager.progress({ workspaceRoot, message, evidence: { kind: 'hook_observation', summary: message, command: input.tool_input?.command || null }, hookEventName: input.hook_event_name, turnId: input.turn_id }); } catch {}
    }
  }
  return { continue: true, suppressOutput: true };
}

function handlePostToolUse(manager, input, workspaceRoot) {
  const current = manager.snapshot({ workspaceRoot, write: false }).snapshot;
  if (!current?.runId || input.tool_name?.includes('overtli_task_manager')) return { continue: true, suppressOutput: true };
  if (!shouldRecordPostToolEvidence(input)) return { continue: true, suppressOutput: true };
  const command = input.tool_input?.command || null;
  const summary = summarizeToolResult(input);
  try {
    manager.progress({
      workspaceRoot,
      taskId: current.currentTaskId,
      message: summary,
      evidence: { kind: inferEvidenceKind(input), summary, command, exitCode: input.tool_response?.exit_code ?? input.tool_response?.status ?? null },
      hookEventName: input.hook_event_name,
      turnId: input.turn_id
    });
  } catch {}
  return { continue: true, suppressOutput: true };
}

function handlePreCompact(manager, input, workspaceRoot) {
  const snap = manager.snapshot({ workspaceRoot, lastUpdate: { kind: 'pre_compact', message: 'Route saved before context compaction.', at: new Date().toISOString() } });
  return { continue: true, suppressOutput: true, systemMessage: snap.markdown };
}

function handlePostCompact(manager, input, workspaceRoot) {
  const snap = manager.snapshot({ workspaceRoot, lastUpdate: { kind: 'post_compact', message: 'Route restored after context compaction.', at: new Date().toISOString() } });
  return { continue: true, suppressOutput: true, systemMessage: snap.markdown };
}

function handleStop(manager, input, workspaceRoot) {
  const audit = manager.auditStop({ workspaceRoot, turnId: input.turn_id, hookEventName: input.hook_event_name });
  if (!audit.run) return { continue: true, suppressOutput: true };
  if (!audit.stopAllowed) {
    const remaining = audit.remainingRequired.map((task) => `- ${task.title} (${task.status})`).join('\n');
    return {
      decision: 'block',
      reason: `Overtli Task Manager audit blocked the stop. Continue the route until required segments are complete:\n${remaining}\n\nUse OTM progress updates, complete tasks only with evidence, then run otm_audit_stop again.`
    };
  }
  try {
    manager.finalizeTurn({ workspaceRoot, runId: audit.run.id, turnId: input.turn_id || audit.run.turnId || 'stop-hook', outcome: 'completed' });
    manager.clearCurrent({ workspaceRoot, runId: audit.run.id });
  } catch (error) {
    return { decision: 'block', reason: `OTM finalization failed and needs one repair pass: ${error.message}` };
  }
  return { continue: true, suppressOutput: true, systemMessage: 'Overtli Task Manager finalized the route, saved the summary, and cleared current.json.' };
}

function classifyToolIntent(input) {
  const name = input.tool_name || '';
  const command = String(input.tool_input?.command || '');
  if (name === 'apply_patch') return 'Applying file changes for the active route segment.';
  if (name === 'Bash' && isValidationCommand(command)) return 'Running validation for the active route segment.';
  if (name === 'Bash') return 'Running a project command for the active route segment.';
  if (name.startsWith('mcp__') && process.env.OTM_TRACK_MCP_EVIDENCE === '1') return `Using ${name} as evidence for the active route segment.`;
  return null;
}

function summarizeToolResult(input) {
  const name = input.tool_name || 'tool';
  const response = input.tool_response || {};
  const code = response.exit_code ?? response.status ?? response.code;
  if (code !== undefined && code !== 0 && code !== '0') return `${name} completed with non-zero result ${code}. Review output before marking completion.`;
  if (name === 'apply_patch') return 'Patch operation completed. Review changed files before marking the task done.';
  if (name === 'Bash') return 'Command completed. Use its output as evidence only if it directly validates the active route segment.';
  return `${name} completed and was recorded as route evidence.`;
}

function inferEvidenceKind(input) {
  const name = input.tool_name || '';
  const command = String(input.tool_input?.command || '');
  if (name === 'apply_patch') return 'file_change';
  if (isValidationCommand(command)) return 'test_result';
  if (name === 'Bash') return 'command_result';
  return 'tool_result';
}

function shouldRecordPostToolEvidence(input) {
  const name = input.tool_name || '';
  const command = String(input.tool_input?.command || '');
  if (name === 'apply_patch') return true;
  if (name.startsWith('mcp__')) return process.env.OTM_TRACK_MCP_EVIDENCE === '1';
  if (name === 'Bash') return isValidationCommand(command) || toolFailed(input);
  return toolFailed(input);
}

function isValidationCommand(command) {
  return /\b(test|lint|check|typecheck|build|vitest|jest|pytest|npm run|pnpm|yarn)\b/i.test(command);
}

function toolFailed(input) {
  const response = input.tool_response || {};
  const code = response.exit_code ?? response.status ?? response.code;
  return code !== undefined && code !== 0 && code !== '0';
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || '{}'); } catch { return fallback; }
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return value;
}
