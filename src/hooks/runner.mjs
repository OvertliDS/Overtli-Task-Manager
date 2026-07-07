import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTaskManager } from '../core/manager.mjs';
import { classifyPrompt } from '../core/planner.mjs';
import { atomicWriteText, cleanupWorkspaceStateTempFiles, ensureDir, findWorkspaceRoot, relativeToWorkspace, workspaceScratchDir, workspaceTempDir } from '../core/fs-utils.mjs';
import { reviewProjectContext } from '../context/project-review.mjs';
import { patchAgentsFile } from '../install/agent-block.mjs';
import { resolveSessionId } from '../core/session-scope.mjs';

export async function runHookScript(eventName, { stdin = '', cwd = process.cwd(), env = process.env } = {}) {
  const input = parseJson(stdin, {});
  const workspaceRoot = findWorkspaceRoot(input.cwd || cwd);
  const sessionId = resolveSessionId(input, env);
  try { cleanupWorkspaceStateTempFiles(workspaceRoot, { sessionId, ...(sessionId ? {} : { scratchMaxAgeMs: -1 }) }); } catch {}
  if (!claimHookInvocation({ eventName, input, workspaceRoot, sessionId, env })) {
    return emitJson({ continue: true, suppressOutput: true });
  }
  const manager = createTaskManager({ cwd: workspaceRoot, env });

  switch (eventName) {
    case 'session-start':
      return emitJson(handleSessionStart(manager, input, workspaceRoot, env));
    case 'user-prompt-submit':
      return emitJson(handleUserPromptSubmit(manager, input, workspaceRoot, env));
    case 'pre-tool-use':
      return emitJson(handlePreToolUse(manager, input, workspaceRoot, env));
    case 'post-tool-use':
      return emitJson(handlePostToolUse(manager, input, workspaceRoot, env));
    case 'pre-compact':
      return emitJson(handlePreCompact(manager, input, workspaceRoot, env));
    case 'post-compact':
      return emitJson(handlePostCompact(manager, input, workspaceRoot, env));
    case 'stop':
      return emitJson(handleStop(manager, input, workspaceRoot, env));
    default:
      return emitJson({ continue: true, suppressOutput: true });
  }
}

function handleSessionStart(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  const agentsSync = syncAgentsInstructions(workspaceRoot, env);
  let projectReview = null;
  try {
    projectReview = reviewProjectContext({ workspaceRoot, maxFiles: Number(env.OTM_PROJECT_REVIEW_MAX_FILES || 20) });
    if (!projectReview.unchanged) {
      manager.upsertMemory({ workspaceRoot, kind: 'project_overview', title: 'Project overview cache', body: projectReview.summary, tags: ['project-overview', 'auto-review'], source: { fingerprint: projectReview.fingerprint, sourceCount: projectReview.sourceCount } });
    }
  } catch {}
  const snap = sessionId
    ? manager.snapshot({ workspaceRoot, sessionId, lastUpdate: { kind: 'session_start', message: 'Session loaded OTM state.', at: new Date().toISOString() } })
    : { run: null, markdown: '' };
  const context = snap.run
    ? `Overtli Task Manager loaded an active route. Continue using OTM tools and keep current.json updated.\n\n${snap.markdown}`
    : `Overtli Task Manager is available. For non-trivial work, call otm_start or otm_reconcile before implementation. Project awareness cache ${projectReview ? (projectReview.unchanged ? 'is current' : 'was refreshed') : 'was not refreshed'}.`;
  const syncMessage = agentsSync.ok
    ? `AGENTS.md managed instructions: ${agentsSync.action}.`
    : `AGENTS.md managed instructions were not synchronized: ${agentsSync.reason}`;
  return { continue: true, suppressOutput: true, systemMessage: `${context}\n${syncMessage}` };
}

function syncAgentsInstructions(workspaceRoot, env) {
  if (env.OTM_AUTO_SYNC_AGENTS === '0') {
    return { ok: true, action: 'disabled by OTM_AUTO_SYNC_AGENTS=0' };
  }
  try {
    return patchAgentsFile({ workspaceRoot });
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

function handleUserPromptSubmit(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  const active = sessionId ? manager.snapshot({ workspaceRoot, sessionId, write: false }).run : null;
  const classification = classifyPrompt(input.prompt || '', Boolean(active));
  if (classification === 'empty' || classification === 'simple') {
    return { continue: true, suppressOutput: true };
  }
  const action = active && ['continue', 'steer'].includes(classification) ? 'otm_reconcile' : 'otm_start';
  const additionalContext = [
    'Overtli Task Manager protocol is active for this turn.',
    `Prompt classification: ${classification}.`,
    `Before editing files or running implementation commands, call ${action} with workspaceRoot set to ${workspaceRoot}.`,
    `This Codex chat is isolated as session ${sessionId || '(unscoped legacy client)'}; OTM tools resolve CODEX_THREAD_ID automatically, so do not reuse route ids from another chat or workspace.`,
    'Before that call, thoroughly analyze the full user request and all context available to you, including inline chat text, attached files, screenshots/images you can inspect, OCR/descriptions, IDE context, and prior steering in this turn.',
    'Create route segments from the main current-scope phases, steps, issues, problems, and deliverables the model identifies; do not collapse distinct requested work into a vague segment like "fix all issues".',
    'Pass those model-derived route segments in the tasks array, with concise titles plus metadata.internalSteps or internalSteps for explicit, inferred, researched, and discovered subwork.',
    'If the user is only asking for a phase plan, roadmap, review, or documentation rather than implementation now, make the route reflect that planning/documentation task instead of converting it into implementation work.',
    'Show the returned Markdown checklist snapshot in chat.',
    'Keep exactly one active route segment when possible; mark completion only with concrete evidence.',
    'Before task-scoped OTM calls, use exact task ids from the latest OTM snapshot/current.json; never guess ids from titles, memory, or prior route state.',
    'Mark internal steps complete with otm_progress as the work happens; complete the parent task only after all required internal steps are terminal and segment-level evidence exists.',
    'If the user steers, reconcile before continuing. Before final response, call otm_audit_stop. If required tasks remain, continue working.',
    'When the audit passes, call otm_finalize_turn, show the returned Markdown summary to the user, then call otm_clear_current.'
  ].join('\n');
  return { continue: true, suppressOutput: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } };
}

function handlePreToolUse(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  const current = manager.snapshot({ workspaceRoot, sessionId, write: false }).snapshot;
  if (!current?.runId || input.tool_name?.includes('overtli_task_manager')) return { continue: true, suppressOutput: true };
  if (process.env.OTM_RECORD_PRE_TOOL === '1') {
    const message = classifyToolIntent(input);
    if (message) {
      try { manager.progress({ workspaceRoot, sessionId, message, evidence: { kind: 'hook_observation', summary: message, command: input.tool_input?.command || null }, hookEventName: input.hook_event_name, turnId: input.turn_id }); } catch {}
    }
  }
  return { continue: true, suppressOutput: true };
}

function handlePostToolUse(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  const current = manager.snapshot({ workspaceRoot, sessionId, write: false }).snapshot;
  if (!current?.runId || input.tool_name?.includes('overtli_task_manager')) return { continue: true, suppressOutput: true };
  if (!shouldRecordPostToolEvidence(input)) return { continue: true, suppressOutput: true };
  const commandEvidence = commandEvidenceForTool(input, workspaceRoot, sessionId);
  const summary = summarizeToolResult(input);
  try {
    manager.progress({
      workspaceRoot,
      sessionId,
      taskId: current.currentTaskId,
      message: summary,
      evidence: { kind: inferEvidenceKind(input), summary, ...commandEvidence, exitCode: input.tool_response?.exit_code ?? input.tool_response?.status ?? null },
      hookEventName: input.hook_event_name,
      turnId: input.turn_id
    });
  } catch {}
  return { continue: true, suppressOutput: true };
}

function handlePreCompact(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  const snap = manager.snapshot({ workspaceRoot, sessionId, lastUpdate: { kind: 'pre_compact', message: 'Route saved before context compaction.', at: new Date().toISOString() } });
  return { continue: true, suppressOutput: true, systemMessage: snap.markdown };
}

function handlePostCompact(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  const snap = manager.snapshot({ workspaceRoot, sessionId, lastUpdate: { kind: 'post_compact', message: 'Route restored after context compaction.', at: new Date().toISOString() } });
  return { continue: true, suppressOutput: true, systemMessage: snap.markdown };
}

function handleStop(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  // Codex marks a Stop invocation triggered by prior Stop-hook feedback. Never
  // block that follow-up again: doing so creates an unbounded continuation loop
  // that no model can terminate on its own.
  if (isActiveStopHook(input)) return { continue: true, suppressOutput: true };

  // A workspace can contain routes from several chats plus legacy unscoped
  // routes. Without a chat identity there is no safe route to enforce, and
  // choosing the newest/legacy route can block on another chat's checklist.
  if (!sessionId) return { continue: true, suppressOutput: true };

  const audit = manager.auditStop({ workspaceRoot, sessionId, turnId: input.turn_id, hookEventName: input.hook_event_name });
  if (!audit.run) return { continue: true, suppressOutput: true };
  if (!audit.stopAllowed) {
    const remaining = audit.remainingRequired.map((task) => `- ${task.title} (${task.status})`).join('\n');
    return {
      decision: 'block',
      reason: `Overtli Task Manager audit blocked the stop. Continue the route until required segments are complete:\n${remaining}\n\nUse OTM progress updates, complete tasks only with evidence, then run otm_audit_stop again.`
    };
  }
  if (process.env.OTM_STOP_AUTO_FINALIZE !== '1') {
    return {
      decision: 'block',
      reason: 'Overtli Task Manager audit passed, but visible finalization must be model-driven. Call otm_finalize_turn, show its Markdown summary to the user, then call otm_clear_current before sending the final response. Set OTM_STOP_AUTO_FINALIZE=1 only when you intentionally want the Stop hook to auto-finalize as a fallback.'
    };
  }
  try {
    manager.finalizeTurn({ workspaceRoot, sessionId, runId: audit.run.id, turnId: input.turn_id || audit.run.turnId || 'stop-hook', outcome: 'completed' });
    manager.clearCurrent({ workspaceRoot, sessionId, runId: audit.run.id });
  } catch (error) {
    return { decision: 'block', reason: `OTM finalization failed and needs one repair pass: ${error.message}` };
  }
  return { continue: true, suppressOutput: true, systemMessage: 'Overtli Task Manager finalized the route, saved the summary, and cleared current.json.' };
}

function isActiveStopHook(input) {
  const value = input.stop_hook_active ?? input.stopHookActive;
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true';
}

function claimHookInvocation({ eventName, input, workspaceRoot, sessionId, env }) {
  if (env.OTM_DEDUPE_HOOKS === '0') return true;
  const configuredTtl = Number(env.OTM_HOOK_DEDUPE_TTL_MS || 10_000);
  const ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0 ? Math.max(1_000, configuredTtl) : 10_000;
  const identity = input.hook_id
    || input.hookId
    || input.invocation_id
    || input.invocationId
    || input.tool_use_id
    || input.toolUseId
    || input.turn_id
    || input.turnId
    || crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const digest = crypto.createHash('sha256').update(`${sessionId || 'unscoped'}:${eventName}:${identity}`).digest('hex').slice(0, 24);
  const dedupeDir = path.join(workspaceTempDir(workspaceRoot), 'hook-invocations');
  const claimPath = path.join(dedupeDir, `${digest}.claim`);
  ensureDir(dedupeDir);
  cleanupHookClaims(dedupeDir, ttlMs);
  try {
    const handle = fs.openSync(claimPath, 'wx');
    try { fs.writeFileSync(handle, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8'); } finally { fs.closeSync(handle); }
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - fs.statSync(claimPath).mtimeMs > ttlMs) {
        fs.rmSync(claimPath, { force: true });
        return claimHookInvocation({ eventName, input, workspaceRoot, sessionId, env });
      }
    } catch {}
    return false;
  }
}

function cleanupHookClaims(dedupeDir, ttlMs) {
  const cutoff = Date.now() - Math.max(ttlMs * 6, 60_000);
  try {
    for (const entry of fs.readdirSync(dedupeDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.claim')) continue;
      const filePath = path.join(dedupeDir, entry.name);
      try { if (fs.statSync(filePath).mtimeMs < cutoff) fs.rmSync(filePath, { force: true }); } catch {}
    }
  } catch {}
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

function commandEvidenceForTool(input, workspaceRoot, sessionId = null) {
  const command = input.tool_input?.command || null;
  if (!command) return {};
  const text = String(command);
  if (text.length <= 800) return { command: text };
  const scratchRoot = workspaceScratchDir(workspaceRoot, sessionId);
  ensureDir(scratchRoot);
  const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${input.tool_name || 'tool'}-${digest}.txt`;
  const filePath = path.join(scratchRoot, fileName);
  atomicWriteText(filePath, text, { tempDir: workspaceTempDir(workspaceRoot) });
  const rel = relativeToWorkspace(workspaceRoot, filePath);
  return {
    command: `[omitted long ${input.tool_name || 'tool'} input; saved to ${rel}]`,
    notes: { scratchFile: rel, originalLength: text.length }
  };
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
