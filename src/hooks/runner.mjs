import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTaskManager } from '../core/manager.mjs';
import { classifyPrompt } from '../core/planner.mjs';
import { atomicWriteText, cleanupWorkspaceStateTempFiles, ensureDir, findWorkspaceRoot, relativeToWorkspace, workspaceScratchDir, workspaceTempDir } from '../core/fs-utils.mjs';
import { reviewProjectContext } from '../context/project-review.mjs';
import { patchAgentsFile } from '../install/agent-block.mjs';
import { resolveSessionId } from '../core/session-scope.mjs';
import { redactSensitiveText } from '../core/validation.mjs';
import { compactOneLine } from '../core/text-utils.mjs';

export async function runHookScript(eventName, { stdin = '', cwd = process.cwd(), env = process.env } = {}) {
  const input = parseJson(stdin, {});
  const workspaceRoot = findWorkspaceRoot(input.cwd || cwd);
  const sessionId = resolveSessionId(input, env);
  let cleanupDiagnostic = null;
  try {
    cleanupWorkspaceStateTempFiles(workspaceRoot, { sessionId, ...(sessionId ? {} : { scratchMaxAgeMs: -1 }) });
  } catch (error) {
    // Hooks remain fail-open, but maintenance errors must be visible instead
    // of being quietly discarded. Redaction keeps host output safe.
    cleanupDiagnostic = `OTM hook diagnostic: startup cleanup was not completed. ${redactSensitiveText(error?.message || String(error))}`;
  }
  let result;
  if (!claimHookInvocation({ eventName, input, workspaceRoot, sessionId, env })) {
    result = { continue: true, suppressOutput: true };
  } else {
    const manager = createTaskManager({ cwd: workspaceRoot, env });
    switch (eventName) {
      case 'session-start': result = handleSessionStart(manager, input, workspaceRoot, env); break;
      case 'user-prompt-submit': result = handleUserPromptSubmit(manager, input, workspaceRoot, env); break;
      case 'pre-tool-use': result = handlePreToolUse(manager, input, workspaceRoot, env); break;
      case 'post-tool-use': result = handlePostToolUse(manager, input, workspaceRoot, env); break;
      case 'pre-compact': result = handlePreCompact(manager, input, workspaceRoot, env); break;
      case 'post-compact': result = handlePostCompact(manager, input, workspaceRoot, env); break;
      case 'stop': result = handleStop(manager, input, workspaceRoot, env); break;
      default: result = { continue: true, suppressOutput: true };
    }
  }
  return emitJson(appendHookDiagnostic(result, cleanupDiagnostic));
}

function appendHookDiagnostic(result, diagnostic) {
  if (!diagnostic) return result;
  return { ...result, systemMessage: [result.systemMessage, diagnostic].filter(Boolean).join('\n') };
}

function handleSessionStart(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  const agentsSync = syncAgentsInstructions(workspaceRoot, env);
  let projectReview = null;
  let projectReviewError = null;
  try {
    projectReview = reviewProjectContext({ workspaceRoot, maxFiles: Number(env.OTM_PROJECT_REVIEW_MAX_FILES || 20) });
    if (!projectReview.unchanged) {
      manager.upsertMemory({ workspaceRoot, kind: 'project_overview', title: 'Project overview cache', body: projectReview.summary, tags: ['project-overview', 'auto-review'], source: { fingerprint: projectReview.fingerprint, sourceCount: projectReview.sourceCount } });
    }
  } catch (error) { projectReviewError = error?.message || String(error); }
  const snap = sessionId
    ? manager.snapshot({ workspaceRoot, sessionId, lastUpdate: { kind: 'session_start', message: 'Session loaded OTM state.', at: new Date().toISOString() } })
    : { run: null, markdown: '' };
  const context = snap.run
    ? `Overtli Task Manager loaded an active route. Continue using OTM tools and keep current.json updated.\n\n${snap.markdown}`
    : `Overtli Task Manager is available. For non-trivial work, call otm_start or otm_reconcile before implementation. Project awareness cache ${projectReview ? (projectReview.unchanged ? 'is current' : 'was refreshed') : 'was not refreshed'}.${projectReviewError ? ` Project-review diagnostic: ${redactSensitiveText(projectReviewError)}` : ''}`;
  const syncMessage = agentsSync.ok
    ? `AGENTS.md managed instructions: ${agentsSync.action}.`
    : `AGENTS.md managed instructions were not synchronized: ${agentsSync.reason}`;
  return { continue: true, suppressOutput: true, systemMessage: `${context}\n${syncMessage}` };
}

function syncAgentsInstructions(workspaceRoot, env) {
  // Session hooks run in repositories that may not have been explicitly
  // installed or trusted for OTM-managed files. Never create or alter an
  // AGENTS file merely because a hook was discovered: both synchronization
  // and trust must be deliberately opted in by the installation owner.
  if (env.OTM_AUTO_SYNC_AGENTS !== '1') {
    return { ok: true, action: 'disabled (set OTM_AUTO_SYNC_AGENTS=1 to enable)' };
  }
  if (env.OTM_TRUSTED_INSTALLATION !== '1') {
    return { ok: true, action: 'not synchronized because OTM_TRUSTED_INSTALLATION=1 is required' };
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
  // The MCP server cannot create a host-native Codex goal, but it can create
  // the durable, session-scoped OTM route immediately. That removes the
  // fragile "model must remember to call otm_start" gap for substantive new
  // requests while retaining model-controlled evidence and task completion.
  let autoRoute = null;
  if (!active && classification === 'new_route' && env.OTM_AUTO_START_ROUTE !== '0') {
    const prompt = String(input.prompt || '').trim();
    autoRoute = manager.start({
      workspaceRoot,
      sessionId,
      turnId: input.turn_id || input.turnId || null,
      goal: compactOneLine(prompt, 180) || 'Complete the requested Codex work',
      prompt,
      context: input.context,
      promptContext: input.prompt_context || input.promptContext,
      attachments: input.attachments,
      screenshots: input.screenshots || input.images,
      source: 'hook-auto-start',
      hookEventName: input.hook_event_name || input.hookEventName || 'UserPromptSubmit',
      invocationId: input.invocation_id || input.invocationId || input.hook_id || input.hookId || null,
      operationId: input.invocation_id || input.invocationId || input.hook_id || input.hookId || null
    });
  }
  const action = active && ['continue', 'steer'].includes(classification) ? 'otm_reconcile' : 'otm_start';
  const effectiveRun = autoRoute?.run || active;
  const activeTask = autoRoute?.snapshot?.tasks?.find((task) => task.id === autoRoute.snapshot.currentTaskId) || null;
  const additionalContext = [
    'Overtli Task Manager protocol is active for this turn.',
    `Prompt classification: ${classification}.`,
    autoRoute
      ? `A durable OTM route was ${autoRoute.reused ? 'reused' : 'created'} automatically for this substantive request. Begin the active segment now${activeTask ? `: ${activeTask.title}` : ''}.`
      : `Before editing files or running implementation commands, call ${action} with workspaceRoot set to ${workspaceRoot}.`,
    `This Codex chat is isolated as session ${sessionId || '(unscoped legacy client)'}; OTM tools resolve CODEX_THREAD_ID automatically, so do not reuse route ids from another chat or workspace.`,
    'Before that call, thoroughly analyze the full user request and all context available to you, including inline chat text, attached files, screenshots/images you can inspect, OCR/descriptions, IDE context, and prior steering in this turn.',
    'Create route segments from the main current-scope phases, steps, issues, problems, and deliverables the model identifies; do not collapse distinct requested work into a vague segment like "fix all issues".',
    'Pass those model-derived route segments in the tasks array, with concise titles plus metadata.internalSteps or internalSteps for explicit, inferred, researched, and discovered subwork.',
    'If the user is only asking for a phase plan, roadmap, review, or documentation rather than implementation now, make the route reflect that planning/documentation task instead of converting it into implementation work.',
    'Show the returned Markdown checklist snapshot in chat.',
    'Keep exactly one active route segment when possible; mark completion only with concrete evidence. After a valid otm_complete_task call, immediately continue work on the returned active next segment instead of stopping or sending a final answer.',
    'Before task-scoped OTM calls, use exact task ids from the latest OTM snapshot/current.json; never guess ids from titles, memory, or prior route state.',
    'Mark internal steps complete with otm_progress as the work happens; complete the parent task only after all required internal steps are terminal and segment-level evidence exists.',
    'If the user steers, reconcile before continuing. A pause preserves this route by workspace/session; on a later continue/resume prompt, load the active snapshot and proceed from its current task. Before final response, call otm_audit_stop. If required tasks remain, continue working.',
    'When the audit passes, call otm_finalize_turn, show the returned Markdown summary to the user, then call otm_clear_current.'
  ].join('\n');
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
    ...(autoRoute ? { otmRoute: { runId: effectiveRun.id, currentTaskId: autoRoute.snapshot.currentTaskId, reused: autoRoute.reused } } : {})
  };
}

function handlePreToolUse(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  const current = manager.snapshot({ workspaceRoot, sessionId, write: false }).snapshot;
  if (!current?.runId || input.tool_name?.includes('overtli_task_manager')) return { continue: true, suppressOutput: true };
  if (env.OTM_RECORD_PRE_TOOL === '1') {
    const message = classifyToolIntent(input, env);
    if (message) {
      try {
        manager.progress({ workspaceRoot, sessionId, message, evidence: { kind: 'hook_observation', summary: message, ...commandEvidenceForTool(input, workspaceRoot, sessionId, env) }, hookEventName: input.hook_event_name, turnId: input.turn_id });
      } catch (error) {
        return hookDiagnostic('pre-tool evidence was not recorded', error);
      }
    }
  }
  return { continue: true, suppressOutput: true };
}

function handlePostToolUse(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  const current = manager.snapshot({ workspaceRoot, sessionId, write: false }).snapshot;
  if (!current?.runId || input.tool_name?.includes('overtli_task_manager')) return { continue: true, suppressOutput: true };
  if (!shouldRecordPostToolEvidence(input, env)) return { continue: true, suppressOutput: true };
  const commandEvidence = commandEvidenceForTool(input, workspaceRoot, sessionId, env);
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
  } catch (error) {
    return hookDiagnostic('post-tool evidence was not recorded', error);
  }
  return { continue: true, suppressOutput: true };
}

function hookDiagnostic(context, error) {
  return {
    continue: true,
    suppressOutput: true,
    systemMessage: `OTM hook diagnostic: ${context}. ${redactSensitiveText(error?.message || String(error))}`
  };
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
  if (env.OTM_STOP_AUTO_FINALIZE !== '1') {
    return {
      decision: 'block',
      reason: 'Overtli Task Manager audit passed, but visible finalization must be model-driven. Call otm_finalize_turn, show its Markdown summary to the user, then call otm_clear_current before sending the final response. Set OTM_STOP_AUTO_FINALIZE=1 only when you intentionally want the Stop hook to auto-finalize as a fallback.'
    };
  }
  try {
    manager.finalizeTurn({ workspaceRoot, sessionId, runId: audit.run.id, turnId: input.turn_id || audit.run.turnId || 'stop-hook', outcome: 'completed' });
    manager.clearCurrent({ workspaceRoot, sessionId, runId: audit.run.id });
  } catch (error) {
    return { decision: 'block', reason: `OTM finalization failed and needs one repair pass: ${redactSensitiveText(error?.message || String(error))}` };
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
  const explicitIdentity = input.hook_id
    || input.hookId
    || input.invocation_id
    || input.invocationId
    || input.tool_use_id
    || input.toolUseId;
  // A turn may contain many tool calls. Without a host-issued tool identity,
  // distinguish them with the complete payload rather than collapsing the
  // entire turn into one claim. Non-tool events retain a stable turn fallback.
  const payloadIdentity = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const identity = explicitIdentity
    || (eventName === 'pre-tool-use' || eventName === 'post-tool-use'
      ? payloadIdentity
      : input.turn_id || input.turnId || payloadIdentity);
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

function classifyToolIntent(input, env) {
  const name = input.tool_name || '';
  const command = String(input.tool_input?.command || '');
  if (name === 'apply_patch') return 'Applying file changes for the active route segment.';
  if (name === 'Bash' && isValidationCommand(command)) return 'Running validation for the active route segment.';
  if (name === 'Bash') return 'Running a project command for the active route segment.';
  if (name.startsWith('mcp__') && env.OTM_TRACK_MCP_EVIDENCE === '1') return `Using ${name} as evidence for the active route segment.`;
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

function commandEvidenceForTool(input, workspaceRoot, sessionId = null, env) {
  const command = input.tool_input?.command || null;
  const files = changedFilesForTool(input);
  if (!command) return files.length ? { files } : {};
  const mode = commandCaptureMode(env);
  if (mode === 'none' || (mode === 'validation-only' && !isValidationCommand(command))) return files.length ? { files } : {};
  const text = redactSensitiveText(command);
  if (text.length <= 800) return { command: text, ...(files.length ? { files } : {}) };
  const scratchRoot = workspaceScratchDir(workspaceRoot, sessionId);
  ensureDir(scratchRoot);
  const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  // Tool names originate with the host. Never place them in a filesystem path;
  // the evidence record can retain its safe human-facing description instead.
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-command-${digest}.txt`;
  const filePath = path.join(scratchRoot, fileName);
  atomicWriteText(filePath, text, { tempDir: workspaceTempDir(workspaceRoot) });
  const rel = relativeToWorkspace(workspaceRoot, filePath);
  return {
    command: `[omitted long ${input.tool_name || 'tool'} input; saved to ${rel}]`,
    notes: { scratchFile: rel, originalLength: text.length },
    ...(files.length ? { files } : {})
  };
}

function commandCaptureMode(env = {}) {
  const value = String(env.OTM_COMMAND_CAPTURE || 'redacted').trim().toLowerCase();
  return ['redacted', 'none', 'validation-only'].includes(value) ? value : 'redacted';
}

function changedFilesForTool(input) {
  const explicit = input.tool_response?.changed_files || input.tool_response?.file_paths || input.tool_input?.files;
  const values = Array.isArray(explicit) ? explicit : [];
  const patch = String(input.tool_input?.patch || input.tool_input?.input || '');
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm)) values.push(match[1]);
  return [...new Set(values.map((value) => String(value).trim()).filter((value) => value && value.length <= 1024 && !value.includes('\0')))];
}

function shouldRecordPostToolEvidence(input, env) {
  const name = input.tool_name || '';
  const command = String(input.tool_input?.command || '');
  if (name === 'apply_patch') return true;
  if (name.startsWith('mcp__')) return env.OTM_TRACK_MCP_EVIDENCE === '1';
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
