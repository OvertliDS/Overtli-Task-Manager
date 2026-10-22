import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createTaskManager } from "../core/manager.mjs";
import { classifyPrompt } from "../core/planner.mjs";
import {
  atomicWriteText,
  cleanupWorkspaceStateTempFiles,
  ensureDir,
  findWorkspaceRoot,
  relativeToWorkspace,
  workspaceScratchDir,
  workspaceTempDir,
} from "../core/fs-utils.mjs";
import { reviewProjectContext } from "../context/project-review.mjs";
import { patchAgentsFile } from "../install/agent-block.mjs";
import { resolveSessionId } from "../core/session-scope.mjs";
import { redactSensitiveText } from "../core/validation.mjs";
import { compactOneLine } from "../core/text-utils.mjs";
import { createProviderSession } from "../core/provider-session.mjs";
import { createProviderAdapter } from "../core/provider-adapter.mjs";
import {
  findPendingWork,
  loadHostEvidenceModule,
  resolveHostEvidenceModulePath,
} from "../core/continuation.mjs";
import { readOwnerWorkEvidence } from "../core/work-evidence.mjs";

export async function runHookScript(
  eventName,
  { stdin = "", cwd = process.cwd(), env = process.env } = {},
) {
  const input = parseJson(stdin, {});
  const hookEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !["OTM_SESSION_ID", "CODEX_THREAD_ID"].includes(key.toUpperCase()),
    ),
  );
  const workspaceRoot = findWorkspaceRoot(input.cwd || cwd);
  if (eventName === "stop" && isActiveStopHook(input))
    return emitJson({ continue: true, suppressOutput: true });
  let sessionId;
  try {
    const officialSessionId =
      typeof input.session_id === "string" ? input.session_id.trim() : "";
    if (!officialSessionId) {
      throw new Error(
        "The official Codex hook payload must contain session_id; environment and alias fields cannot replace it.",
      );
    }
    sessionId = resolveSessionId(input, hookEnv);
    if (sessionId !== officialSessionId) {
      throw new Error(
        "Codex hook session_id conflicts with another supplied session alias.",
      );
    }
  } catch (error) {
    const message = `OTM hook diagnostic: invalid or missing official session identity; no route state was read or changed. ${redactSensitiveText(error?.message || String(error))}`;
    if (eventName === "pre-tool-use" && isOdcBackgroundDispatch(input)) {
      return emitJson({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `OTM blocked this ODC background-work call because the official Codex session identity is missing or conflicting. ${message}`,
        },
      });
    }
    return emitJson(
      eventName === "stop"
        ? { decision: "block", reason: message, suppressOutput: true }
        : { continue: true, suppressOutput: true, systemMessage: message },
    );
  }
  let cleanupDiagnostic = null;
  try {
    cleanupWorkspaceStateTempFiles(workspaceRoot, {
      sessionId,
      ...(sessionId ? {} : { scratchMaxAgeMs: -1 }),
    });
  } catch (error) {
    // Hooks remain fail-open, but maintenance errors must be visible instead
    // of being quietly discarded. Redaction keeps host output safe.
    cleanupDiagnostic = `OTM hook diagnostic: startup cleanup was not completed. ${redactSensitiveText(error?.message || String(error))}`;
  }
  let result;
  if (
    !claimHookInvocation({
      eventName,
      input,
      workspaceRoot,
      sessionId,
      env: hookEnv,
    })
  ) {
    result = { continue: true, suppressOutput: true };
  } else {
    const manager = createTaskManager({ cwd: workspaceRoot, env: hookEnv });
    const actualEventName =
      input.hook_event_name || codexHookEventName(eventName);
    const isOdcDispatch =
      eventName === "pre-tool-use" && isOdcBackgroundDispatch(input);
    try {
      const current = manager.snapshot({
        workspaceRoot,
        sessionId,
        write: false,
      });
      if (current.run && !current.run.metadata?.providerSession) {
        manager.bindCodexOwner({
          runId: current.run.id,
          sessionId,
          officialSessionId: sessionId,
          expectedRevision: current.run.routeRevision,
          hookEventName: actualEventName,
        });
      }
      // Record the route-scoped activity before dispatch. A concurrent owner
      // transfer then sees this newer event, and a stale owner cannot proceed
      // after the transfer CAS has changed the binding.
      if (eventName === "pre-tool-use") {
        recordCodexHostObservation(
          manager,
          eventName,
          input,
          workspaceRoot,
          sessionId,
          { activityOnly: true },
        );
      }
      const observation = await recordTrustedCodexHostObservation(
        manager,
        actualEventName,
        input,
        workspaceRoot,
        sessionId,
        hookEnv,
      );
      if (
        isOdcDispatch &&
        (!observation || observation.dispatchAllowed !== true)
      ) {
        const code = observation?.code || "HOST_OBSERVER_UNAVAILABLE";
        result = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `OTM blocked this ODC background-work call because trusted owner coverage was not recorded (${code}). Resolve the host evidence issue, then retry the exact operation.`,
          },
        };
      } else {
        switch (eventName) {
          case "session-start":
            result = handleSessionStart(manager, input, workspaceRoot, hookEnv);
            break;
          case "user-prompt-submit":
            result = handleUserPromptSubmit(
              manager,
              input,
              workspaceRoot,
              hookEnv,
            );
            break;
          case "pre-tool-use":
            result = handlePreToolUse(manager, input, workspaceRoot, hookEnv);
            break;
          case "post-tool-use":
          case "post-tool-use-failure":
            result = handlePostToolUse(manager, input, workspaceRoot, hookEnv);
            break;
          case "subagent-start":
          case "subagent-stop":
            result = { continue: true, suppressOutput: true };
            break;
          case "pre-compact":
            result = handlePreCompact(manager, input, workspaceRoot, hookEnv);
            break;
          case "post-compact":
            result = handlePostCompact(manager, input, workspaceRoot, hookEnv);
            break;
          case "stop":
            result = handleStop(
              manager,
              input,
              workspaceRoot,
              hookEnv,
              observation,
            );
            break;
          default:
            result = { continue: true, suppressOutput: true };
        }
      }
      if (eventName === "pre-tool-use") {
        const blockedOdc =
          isOdcDispatch &&
          result?.hookSpecificOutput?.permissionDecision === "deny";
        if (!blockedOdc) {
          recordCodexHostObservation(
            manager,
            eventName,
            input,
            workspaceRoot,
            sessionId,
            { workOnly: true },
          );
        }
      } else {
        recordCodexHostObservation(
          manager,
          eventName,
          input,
          workspaceRoot,
          sessionId,
        );
      }
    } catch (error) {
      if (isOdcDispatch) {
        result = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `OTM blocked this ODC background-work call because its pre-dispatch owner receipt failed. ${redactSensitiveText(error?.message || String(error))}`,
          },
        };
      } else if (eventName === "stop" && !isActiveStopHook(input)) {
        result = {
          decision: "block",
          reason: `OTM could not verify settled host work before Stop. ${redactSensitiveText(error?.message || String(error))} Resolve the exact host evidence or route-history error, then retry.`,
        };
      }
      cleanupDiagnostic = [
        cleanupDiagnostic,
        `OTM hook diagnostic: provider liveness evidence was not recorded. ${redactSensitiveText(error?.message || String(error))}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
  }
  return emitJson(appendHookDiagnostic(result, cleanupDiagnostic));
}

async function recordTrustedCodexHostObservation(
  manager,
  eventName,
  input,
  workspaceRoot,
  sessionId,
  env,
) {
  const modulePath = resolveHostEvidenceModulePath(env);
  if (!sessionId) return null;
  if (!modulePath) return null;
  const providerSession = createProviderSession({
    provider: "codex",
    nativeSessionId: sessionId,
  });
  const current = manager.snapshot({ workspaceRoot, sessionId, write: false });
  const run =
    current.run?.metadata?.providerSession?.provider === "codex" &&
    current.run.metadata.providerSession.nativeSessionId === sessionId
      ? current.run
      : null;
  const module = await loadHostEvidenceModule(modulePath);
  if (!module.observeHostHook) return null;
  return module.observeHostHook({
    schemaVersion: "otm.host-hook-observation.v1",
    provider: "codex",
    eventName,
    payload: input,
    workspaceRoot,
    nativeSessionId: sessionId,
    providerSessionKey: providerSession.providerSessionKey,
    sessionId: providerSession.sessionId,
    run,
    routeRevision: run?.routeRevision ?? null,
  });
}

function codexHookEventName(eventName) {
  return (
    {
      "session-start": "SessionStart",
      "user-prompt-submit": "UserPromptSubmit",
      "pre-tool-use": "PreToolUse",
      "post-tool-use": "PostToolUse",
      "post-tool-use-failure": "PostToolUseFailure",
      "subagent-start": "SubagentStart",
      "subagent-stop": "SubagentStop",
      "pre-compact": "PreCompact",
      "post-compact": "PostCompact",
      stop: "Stop",
    }[eventName] || eventName
  );
}

function isOdcBackgroundDispatch(input) {
  const name = String(input?.tool_name || "");
  const prefix = "mcp__desktop-commander__";
  if (!name.startsWith(prefix)) return false;
  let operation = name.slice(prefix.length);
  let action = String(input?.tool_input?.action || "").toLowerCase();
  if (operation === "system_write") {
    operation = String(input?.tool_input?.operationId || "");
    if (!operation) return false;
  }
  const asynchronousOperations = new Set([
    "process_job",
    "script_job",
    "execution_provider",
    "agent_delegate",
    "orchestration",
    "process_run",
    "script_run",
    "youtube_media",
    "audio_analysis",
    "media_proxy_pool",
    "provider_contract",
    "batch_execute",
  ]);
  if (!asynchronousOperations.has(operation)) return false;
  if (["status", "output", "get", "list", "inspect", "search"].includes(action))
    return false;
  // Unknown actions on a known asynchronous route require trusted host review;
  // a missing or changed schema must not bypass the pre-dispatch gate.
  return true;
}

function appendHookDiagnostic(result, diagnostic) {
  if (!diagnostic) return result;
  return {
    ...result,
    systemMessage: [result.systemMessage, diagnostic]
      .filter(Boolean)
      .join("\n"),
  };
}

function handleSessionStart(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  const agentsSync = syncAgentsInstructions(workspaceRoot, env);
  let projectReview = null;
  let projectReviewError = null;
  try {
    projectReview = reviewProjectContext({
      workspaceRoot,
      maxFiles: Number(env.OTM_PROJECT_REVIEW_MAX_FILES || 20),
    });
    if (!projectReview.unchanged) {
      manager.upsertMemory({
        workspaceRoot,
        kind: "project_overview",
        title: "Project overview cache",
        body: projectReview.summary,
        tags: ["project-overview", "auto-review"],
        source: {
          fingerprint: projectReview.fingerprint,
          sourceCount: projectReview.sourceCount,
        },
      });
    }
  } catch (error) {
    projectReviewError = error?.message || String(error);
  }
  const snap = sessionId
    ? manager.snapshot({
        workspaceRoot,
        sessionId,
        lastUpdate: {
          kind: "session_start",
          message: "Session loaded OTM state.",
          at: new Date().toISOString(),
        },
      })
    : { run: null, markdown: "" };
  const context = snap.run
    ? `Overtli Task Manager loaded an active route. Continue using OTM tools and keep current.json updated.\n\n${snap.markdown}`
    : `Overtli Task Manager is available. For non-trivial work, call otm_start or otm_reconcile before implementation. Project awareness cache ${projectReview ? (projectReview.unchanged ? "is current" : "was refreshed") : "was not refreshed"}.${projectReviewError ? ` Project-review diagnostic: ${redactSensitiveText(projectReviewError)}` : ""}`;
  const syncMessage = agentsSync.ok
    ? `AGENTS.md managed instructions: ${agentsSync.action}.`
    : `AGENTS.md managed instructions were not synchronized: ${agentsSync.reason}`;
  if (input.source === "compact") {
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `${context}\n${syncMessage}`,
      },
    };
  }
  return {
    continue: true,
    suppressOutput: true,
    systemMessage: `${context}\n${syncMessage}`,
  };
}

function syncAgentsInstructions(workspaceRoot, env) {
  // An installed OTM hook owns only its marker-delimited block and is the
  // reliable place to keep its instructions current. An explicit opt-out is
  // still available for repositories that must not receive managed guidance.
  if (env.OTM_AUTO_SYNC_AGENTS === "0") {
    return {
      ok: true,
      action: "disabled (set OTM_AUTO_SYNC_AGENTS=1 to re-enable)",
    };
  }
  try {
    return patchAgentsFile({ workspaceRoot });
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

function handleUserPromptSubmit(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  // SessionStart can be skipped by clients that attach hooks after opening a
  // workspace. Recheck here so the first substantive prompt still creates or
  // refreshes the root instruction block.
  const agentsSync = syncAgentsInstructions(workspaceRoot, env);
  const active = sessionId
    ? manager.snapshot({ workspaceRoot, sessionId, write: false }).run
    : null;
  const classification = classifyPrompt(input.prompt || "", Boolean(active));
  if (classification === "empty" || classification === "simple") {
    return { continue: true, suppressOutput: true };
  }
  // The MCP server cannot create a host-native Codex goal, but it can create
  // the durable, session-scoped OTM route immediately. That removes the
  // fragile "model must remember to call otm_start" gap for substantive new
  // requests while retaining model-controlled evidence and task completion.
  let autoRoute = null;
  if (
    !active &&
    classification === "new_route" &&
    env.OTM_AUTO_START_ROUTE !== "0"
  ) {
    const prompt = String(input.prompt || "").trim();
    autoRoute = manager.start({
      workspaceRoot,
      sessionId,
      turnId: input.turn_id || input.turnId || null,
      goal: compactOneLine(prompt, 180) || "Complete the requested Codex work",
      prompt,
      context: input.context,
      promptContext: input.prompt_context || input.promptContext,
      attachments: input.attachments,
      screenshots: input.screenshots,
      images: input.images,
      source: "hook-auto-start",
      providerContext: providerContextFor(sessionId),
      hookEventName:
        input.hook_event_name || input.hookEventName || "UserPromptSubmit",
      invocationId:
        input.invocation_id ||
        input.invocationId ||
        input.hook_id ||
        input.hookId ||
        null,
      operationId:
        input.invocation_id ||
        input.invocationId ||
        input.hook_id ||
        input.hookId ||
        null,
    });
  }
  let contextRoute = null;
  if (active) {
    contextRoute = manager.reconcile({
      workspaceRoot,
      sessionId,
      runId: active.id,
      mode: classification === "continue" ? "continue" : "steer",
      prompt: String(input.prompt || "").trim(),
      context: input.context,
      promptContext: input.prompt_context || input.promptContext,
      attachments: input.attachments,
      screenshots: input.screenshots,
      images: input.images,
      hookEventName:
        input.hook_event_name || input.hookEventName || "UserPromptSubmit",
      invocationId:
        input.invocation_id ||
        input.invocationId ||
        input.hook_id ||
        input.hookId ||
        null,
    });
  }
  const action = active ? "otm_reconcile" : "otm_start";
  const effectiveRun = contextRoute?.run || autoRoute?.run || active;
  const activeTask =
    (contextRoute?.snapshot || autoRoute?.snapshot)?.tasks?.find(
      (task) =>
        task.id ===
        (contextRoute?.snapshot || autoRoute?.snapshot).currentTaskId,
    ) || null;
  const additionalContext = [
    "Overtli Task Manager protocol is active for this turn.",
    `Prompt classification: ${classification}.`,
    agentsSync.ok
      ? `Root AGENTS.md managed instructions: ${agentsSync.action}.`
      : `Root AGENTS.md managed instructions were not synchronized: ${agentsSync.reason}`,
    autoRoute
      ? `A conservative durable OTM bootstrap route was ${autoRoute.reused ? "reused" : "created"} automatically for this substantive request${activeTask ? `: ${activeTask.title}` : ""}. Before implementation, call otm_reconcile with the model-authored three-tier route; the fallback scaffold is intentionally not completable.`
      : contextRoute
        ? "The new prompt and structured/attachment/visual context were appended to the canonical session contract. Re-review the entire accumulated contract and call otm_reconcile with the updated model-authored hierarchy before completing more route gates."
        : `Before editing files or running implementation commands, call ${action} with workspaceRoot set to ${workspaceRoot}.`,
    `This Codex chat resolves to root session ${sessionId || "(unscoped legacy client)"}. OTM uses that session before workspace paths; the route's primary workspace remains its evidence authority and later home/project/nested paths are aliases. Never reuse route ids from another Codex session.`,
    "Before that call, thoroughly analyze the full user request and all context available to you, including inline chat text, attached files, screenshots/images you can inspect, OCR/descriptions, IDE context, and prior steering in this turn.",
    "Map the full request before implementation, then keep reconciling it as evidence or steering arrives. Explicit identifiers, wording, order, constraints, and acceptance conditions remain authoritative.",
    'Tier 1 is a bounded route segment/completion gate for a major outcome (for example Phase 3), with a concise outcome/gist, dependencies, provenance/source references, acceptance conditions, and gate evidence policy. Do not collapse distinct requested work into a vague gate such as "fix all issues".',
    "Tag every Tier 1 gate with its actual model-interpreted workType. Prompts may mix planning, review, research, documentation, implementation, validation, release, deployment, operations, or justified custom work: preserve each gate's intent and let the overall route report mixed rather than forcing one lossy label.",
    "Tier 2 is the gate's ordered internalSteps: preserve explicit children such as Phase 3.1/3.2; when absent, infer only the smallest complete outcome-specific subtasks from the full accumulated contract. Mark inferred content as model-derived rather than user-authored.",
    "Tier 3 is miniSteps under each non-atomic internal subtask: concrete, verifiable actions needed to finish that specific subtask. A genuinely atomic subtask must set atomic=true with a rationale. OTM provides structure and lifecycle gates; the model owns all domain content.",
    "Never populate every gate/subtask with the same canned checklist. A deterministic fallback remains needsModelReview and must be replaced through reconciliation before implementation.",
    "Treat inline chat, pasted text, prompt context, attachment/OCR text, and screenshot/image descriptions as one accumulated bounded source contract with provenance. On steering, re-review all preserved sources and retain valid IDs, evidence, ordering, and supersession history.",
    "Use evidence and completion criteria appropriate to each gate's workType. Planning/review/research/documentation gates must not imply unrequested code changes; implementation gates still require implementation, integration, validation, and synchronized documentation evidence.",
    "Show the returned Markdown checklist snapshot in chat.",
    "Use Codex native goal control now when it is available: create one goal if this chat has none, with an objective that requires completion of every requested phase and task. Keep that goal active while OTM tracks detailed route progress; only mark it complete after the OTM stop audit passes, or blocked after a genuine unresolved blocker.",
    "Keep exactly one active route segment when possible; mark completion only with concrete evidence. After a valid otm_complete_task call, immediately continue work on the returned active next segment instead of stopping or sending a final answer.",
    "Before task-scoped OTM calls, use exact task ids from the latest canonical OTM snapshot or current.json in the route's primary workspace; never use the workspace index or guess ids from titles, memory, or another session.",
    "Mark mini-steps and internal subtasks complete with otm_progress as evidence arrives; complete the parent gate only after all required descendants are terminal and segment-level evidence exists.",
    "If the user steers, reconcile before continuing. A pause preserves this route by root Codex session across workspace aliases; on a later continue/resume prompt, load the canonical snapshot and proceed from its current task. Before final response, call otm_audit_stop. If required tasks remain, continue working.",
    "When the audit passes, allow the Stop hook to finalize, save the summary, and clear automatically. Only call otm_finalize_turn and otm_clear_current manually when OTM_STOP_AUTO_FINALIZE=0.",
  ].join("\n");
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
    ...(autoRoute
      ? {
          otmRoute: {
            runId: effectiveRun.id,
            currentTaskId: autoRoute.snapshot.currentTaskId,
            reused: autoRoute.reused,
          },
        }
      : {}),
  };
}

function recordCodexHostObservation(
  manager,
  eventName,
  input,
  workspaceRoot,
  sessionId,
  { activityOnly = false, workOnly = false } = {},
) {
  if (!sessionId) return;
  const current = manager.snapshot({ workspaceRoot, sessionId, write: false });
  const run = current.run;
  const providerSession = run?.metadata?.providerSession;
  if (
    !run ||
    providerSession?.provider !== "codex" ||
    providerSession.nativeSessionId !== sessionId
  )
    return;
  const provider = createProviderSession({
    provider: "codex",
    nativeSessionId: sessionId,
  });
  const common = {
    provider: "codex",
    providerSessionKey: provider.providerSessionKey,
    ownerSessionId: sessionId,
    nativeSessionId: sessionId,
    hookEventName: input.hook_event_name || eventName,
  };
  const operationId = (kind) =>
    crypto
      .createHash("sha256")
      .update(
        `${provider.providerSessionKey}:${eventName}:${input.tool_use_id || input.toolUseId || input.turn_id || "session"}:${kind}:${Date.now()}`,
      )
      .digest("hex");
  const observations = activityOnly
    ? [
        {
          eventType: "provider_session_activity",
          payload: { ...common, activityKind: eventName },
        },
      ]
    : workOnly
      ? []
      : [
          {
            eventType: "provider_session_activity",
            payload: { ...common, activityKind: eventName },
          },
        ];
  const toolId = input.tool_use_id || input.toolUseId;
  const agentId = input.agent_id || input.agentId;
  const isOtmTool = String(input.tool_name || "").includes(
    "overtli_task_manager",
  );
  if (
    !activityOnly &&
    !isOtmTool &&
    (eventName === "pre-tool-use" || eventName === "post-tool-use")
  ) {
    observations.push({
      eventType:
        eventName === "pre-tool-use"
          ? "provider_host_work_started"
          : "provider_host_work_settled",
      payload: {
        ...common,
        workId: typeof toolId === "string" && toolId ? `tool:${toolId}` : null,
        workLabel: "Codex tool use",
      },
    });
  }
  if (eventName === "subagent-start" || eventName === "subagent-stop") {
    const validAgentId =
      typeof agentId === "string" && agentId.trim() && agentId.length <= 256;
    observations.push({
      eventType:
        eventName === "subagent-start"
          ? "provider_host_work_started"
          : "provider_host_work_settled",
      payload: {
        ...common,
        workId: validAgentId ? `subagent:${agentId.trim()}` : null,
        workLabel: "Codex subagent",
        agentType:
          typeof input.agent_type === "string" && input.agent_type.length <= 128
            ? input.agent_type
            : null,
      },
    });
  }
  for (const observation of observations) {
    manager.recordOwnedEvent({
      runId: run.id,
      sessionId,
      expectedRevision: run.routeRevision,
      ...observation,
      context: {
        operationId: operationId(observation.eventType),
        hookEventName: common.hookEventName,
        turnId: input.turn_id || null,
      },
    });
  }
}

function providerContextFor(nativeSessionId) {
  const session = createProviderSession({ provider: "codex", nativeSessionId });
  return {
    provider: session.provider,
    providerSessionKey: session.providerSessionKey,
    nativeSessionId,
  };
}

function handlePreToolUse(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  const current = manager.snapshot({
    workspaceRoot,
    sessionId,
    write: false,
  }).snapshot;
  if (!current?.runId || input.tool_name?.includes("overtli_task_manager"))
    return { continue: true, suppressOutput: true };
  if (env.OTM_RECORD_PRE_TOOL === "1") {
    const message = classifyToolIntent(input, env);
    if (message) {
      try {
        manager.progress({
          workspaceRoot,
          sessionId,
          message,
          evidence: {
            kind: "hook_observation",
            summary: message,
            ...commandEvidenceForTool(input, workspaceRoot, sessionId, env),
          },
          hookEventName: input.hook_event_name,
          turnId: input.turn_id,
        });
      } catch (error) {
        return hookDiagnostic("pre-tool evidence was not recorded", error);
      }
    }
  }
  return { continue: true, suppressOutput: true };
}

function handlePostToolUse(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  const current = manager.snapshot({
    workspaceRoot,
    sessionId,
    write: false,
  }).snapshot;
  if (!current?.runId || input.tool_name?.includes("overtli_task_manager"))
    return { continue: true, suppressOutput: true };
  if (!shouldRecordPostToolEvidence(input, env))
    return { continue: true, suppressOutput: true };
  const commandEvidence = commandEvidenceForTool(
    input,
    workspaceRoot,
    sessionId,
    env,
  );
  const summary = summarizeToolResult(input);
  try {
    manager.progress({
      workspaceRoot,
      sessionId,
      taskId: current.currentTaskId,
      message: summary,
      evidence: {
        kind: inferEvidenceKind(input),
        summary,
        ...commandEvidence,
        exitCode:
          input.tool_response?.exit_code ?? input.tool_response?.status ?? null,
      },
      hookEventName: input.hook_event_name,
      turnId: input.turn_id,
    });
  } catch (error) {
    return hookDiagnostic("post-tool evidence was not recorded", error);
  }
  return { continue: true, suppressOutput: true };
}

function hookDiagnostic(context, error) {
  return {
    continue: true,
    suppressOutput: true,
    systemMessage: `OTM hook diagnostic: ${context}. ${redactSensitiveText(error?.message || String(error))}`,
  };
}

function handlePreCompact(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  const snap = manager.snapshot({ workspaceRoot, sessionId, write: false });
  if (!snap.run) return { continue: true, suppressOutput: true };
  const adapter = createProviderAdapter({
    provider: "codex",
    nativeSessionId: sessionId,
    workspaceRoot,
    env,
    store: manager.store,
  });
  try {
    adapter.checkpoint({
      runId: snap.run.id,
      workspaceRoot,
      checkpointKey: `codex-compact:${input.trigger || "unknown"}:${snap.run.routeRevision}`,
    });
  } catch (error) {
    return hookDiagnostic("canonical route checkpoint was not recorded", error);
  } finally {
    adapter.close();
  }
  return { continue: true, suppressOutput: true };
}

function handlePostCompact(manager, input, workspaceRoot, env) {
  const sessionId = resolveSessionId(input, env);
  if (!sessionId) return { continue: true, suppressOutput: true };
  manager.snapshot({ workspaceRoot, sessionId, write: false });
  return { continue: true, suppressOutput: true };
}

function handleStop(
  manager,
  input,
  workspaceRoot,
  env,
  hostObservation = null,
) {
  const sessionId = resolveSessionId(input, env);
  // Codex marks a Stop invocation triggered by prior Stop-hook feedback. Never
  // block that follow-up again: doing so creates an unbounded continuation loop
  // that no model can terminate on its own.
  if (isActiveStopHook(input)) return { continue: true, suppressOutput: true };

  // A workspace can contain routes from several chats plus legacy unscoped
  // routes. Without a chat identity there is no safe route to enforce, and
  // choosing the newest/legacy route can block on another chat's checklist.
  if (!sessionId) return { continue: true, suppressOutput: true };

  let audit;
  try {
    audit = manager.auditStop({
      workspaceRoot,
      sessionId,
      turnId: input.turn_id,
      hookEventName: input.hook_event_name,
    });
  } catch (error) {
    if (error?.code !== "CANONICAL_ROUTE_AMBIGUOUS") throw error;
    return {
      decision: "block",
      reason: `Overtli Task Manager needs an explicit legacy route selection before Stop can continue. ${redactSensitiveText(error?.message || String(error))}`,
      otmIdentity: {
        rootSessionId: sessionId,
        canonicalTaskId: null,
        primaryWorkspace: null,
        workspaceAliases: [],
        stopResolvedTaskId: null,
        modelReasoningRequired: true,
        resolution: "legacy_conflict",
        candidates: error.details?.candidates || [],
      },
    };
  }
  if (!audit.run)
    return {
      continue: true,
      suppressOutput: true,
      otmIdentity: audit.canonicalIdentity,
    };
  if (!audit.stopAllowed) {
    const current = audit.remainingRequired.find(
      (task) => task.id === audit.run.currentTaskId,
    ) ||
      audit.remainingRequired[0] || {
        title: "Reconcile the accumulated source contract",
        status: "needs_model_review",
      };
    const remainingCount = audit.remainingRequired.length;
    return {
      decision: "block",
      reason: `Overtli Task Manager audit blocked the stop. Continue the current route segment: ${current.title} (${current.status}). ${remainingCount > 1 ? `${remainingCount - 1} later required segment${remainingCount === 2 ? "" : "s"} remain queued.` : "This is the final required segment."}\n\nRecord the next concrete internal-step evidence, complete this segment only when its required internal steps are terminal, then continue directly to the returned next segment. The hook will finalize and clear automatically once the audit passes.`,
      otmIdentity: audit.canonicalIdentity,
    };
  }
  const workBlocker = codexStopWorkBlocker(
    manager,
    audit.run,
    sessionId,
    hostObservation,
  );
  if (workBlocker) {
    return {
      decision: "block",
      reason: `Overtli Task Manager cannot finalize this route while host work is active or unknown (${workBlocker}). Wait for the exact tools and subagents to settle, verify trusted owner coverage and complete OTM hook receipts, then retry Stop.`,
      otmIdentity: {
        ...audit.canonicalIdentity,
        modelReasoningRequired: false,
      },
    };
  }
  if (
    audit.run.finalizedAt &&
    ["completed", "cleared"].includes(audit.run.status)
  ) {
    let summary = manager.store.listSummariesForRun(audit.run.id)[0] || null;
    if (!summary) {
      try {
        const repaired = manager.finalizeTurn({
          workspaceRoot,
          sessionId,
          runId: audit.run.id,
          turnId: input.turn_id || audit.run.turnId || "canonical-stop-repair",
          outcome: "completed",
        });
        summary = repaired.summary;
      } catch (error) {
        return {
          decision: "block",
          reason: `The canonical route is complete, but its saved summary needs deterministic repair before Stop can continue. ${redactSensitiveText(error?.message || String(error))}`,
          otmIdentity: {
            ...audit.canonicalIdentity,
            modelReasoningRequired: false,
          },
        };
      }
    }
    return {
      continue: true,
      suppressOutput: true,
      otmIdentity: {
        ...audit.canonicalIdentity,
        resolution: "completed_canonical_summary_reused",
        summaryId: summary?.id || null,
        modelReasoningRequired: false,
      },
    };
  }
  if (env.OTM_STOP_AUTO_FINALIZE === "0") {
    return {
      decision: "block",
      reason:
        "Overtli Task Manager audit passed. Automatic finalization is disabled for this session; call otm_finalize_turn, show its Markdown summary, then call otm_clear_current before the final response.",
      otmIdentity: {
        ...audit.canonicalIdentity,
        modelReasoningRequired: false,
      },
    };
  }
  let finalized;
  try {
    finalized = manager.finalizeTurn({
      workspaceRoot,
      sessionId,
      runId: audit.run.id,
      turnId: input.turn_id || audit.run.turnId || "stop-hook",
      outcome: "completed",
    });
    manager.clearCurrent({ workspaceRoot, sessionId, runId: audit.run.id });
  } catch (error) {
    return {
      decision: "block",
      reason: `OTM finalization failed and needs one repair pass: ${redactSensitiveText(error?.message || String(error))}`,
    };
  }
  return {
    continue: true,
    suppressOutput: true,
    otmIdentity: {
      ...audit.canonicalIdentity,
      resolution: "completed_canonical_route_finalized",
      summaryId: finalized.summary?.id || null,
      modelReasoningRequired: false,
    },
  };
}

function codexStopWorkBlocker(manager, run, sessionId, hostObservation) {
  const coverage = hostObservation?.coverage;
  if (hostObservation !== null) {
    if (
      hostObservation?.observed !== true ||
      coverage?.complete !== true ||
      !Number.isSafeInteger(coverage.pendingCount) ||
      coverage.pendingCount < 0
    ) {
      return safeBlockerCode(
        hostObservation?.code || coverage?.code || "HOST_WORK_UNKNOWN",
      );
    }
    if (coverage.pendingCount > 0) return "ODC_WORK_PENDING";
  }

  try {
    const providerSession = run.metadata?.providerSession;
    if (!providerSession) return null;
    if (
      providerSession.provider !== "codex" ||
      providerSession.nativeSessionId !== sessionId
    )
      return "OWNER_ACTIVITY_UNKNOWN";
    const ownerEvents = readOwnerWorkEvidence(manager.store, run.id, {
      ownerSessionId: sessionId,
      providerSessionKey: providerSession.providerSessionKey,
    });
    if (!ownerEvents) return "OTM_EVENT_HISTORY_INCOMPLETE";
    if (findPendingWork(ownerEvents).length > 0) return "HOST_WORK_PENDING";
  } catch {
    return "OTM_EVENT_HISTORY_UNAVAILABLE";
  }
  return null;
}

function safeBlockerCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_-]{1,79}$/.test(value)
    ? value
    : "HOST_WORK_UNKNOWN";
}

function isActiveStopHook(input) {
  const value = input.stop_hook_active ?? input.stopHookActive;
  return (
    value === true ||
    value === 1 ||
    String(value || "").toLowerCase() === "true"
  );
}

function claimHookInvocation({
  eventName,
  input,
  workspaceRoot,
  sessionId,
  env,
}) {
  if (env.OTM_DEDUPE_HOOKS === "0") return true;
  const configuredTtl = Number(env.OTM_HOOK_DEDUPE_TTL_MS || 10_000);
  const ttlMs =
    Number.isFinite(configuredTtl) && configuredTtl > 0
      ? Math.max(1_000, configuredTtl)
      : 10_000;
  const explicitIdentity =
    input.hook_id ||
    input.hookId ||
    input.invocation_id ||
    input.invocationId ||
    input.tool_use_id ||
    input.toolUseId ||
    input.agent_id ||
    input.agentId;
  // A turn may contain many tool calls. Without a host-issued tool identity,
  // distinguish them with the complete payload rather than collapsing the
  // entire turn into one claim. Non-tool events retain a stable turn fallback.
  const payloadIdentity = crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  const identity =
    explicitIdentity ||
    (eventName === "pre-tool-use" || eventName === "post-tool-use"
      ? payloadIdentity
      : input.turn_id || input.turnId || payloadIdentity);
  const digest = crypto
    .createHash("sha256")
    .update(`${sessionId || "unscoped"}:${eventName}:${identity}`)
    .digest("hex")
    .slice(0, 24);
  const dedupeDir = path.join(
    workspaceTempDir(workspaceRoot),
    "hook-invocations",
  );
  const claimPath = path.join(dedupeDir, `${digest}.claim`);
  ensureDir(dedupeDir);
  cleanupHookClaims(dedupeDir, ttlMs);
  try {
    const handle = fs.openSync(claimPath, "wx");
    try {
      fs.writeFileSync(
        handle,
        `${process.pid}\n${new Date().toISOString()}\n`,
        "utf8",
      );
    } finally {
      fs.closeSync(handle);
    }
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      if (Date.now() - fs.statSync(claimPath).mtimeMs > ttlMs) {
        fs.rmSync(claimPath, { force: true });
        return claimHookInvocation({
          eventName,
          input,
          workspaceRoot,
          sessionId,
          env,
        });
      }
    } catch {}
    return false;
  }
}

function cleanupHookClaims(dedupeDir, ttlMs) {
  const cutoff = Date.now() - Math.max(ttlMs * 6, 60_000);
  try {
    for (const entry of fs.readdirSync(dedupeDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".claim")) continue;
      const filePath = path.join(dedupeDir, entry.name);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff)
          fs.rmSync(filePath, { force: true });
      } catch {}
    }
  } catch {}
}

function classifyToolIntent(input, env) {
  const name = input.tool_name || "";
  const command = String(input.tool_input?.command || "");
  if (name === "apply_patch")
    return "Applying file changes for the active route segment.";
  if (name === "Bash" && isValidationCommand(command))
    return "Running validation for the active route segment.";
  if (name === "Bash")
    return "Running a project command for the active route segment.";
  if (name.startsWith("mcp__") && env.OTM_TRACK_MCP_EVIDENCE === "1")
    return `Using ${name} as evidence for the active route segment.`;
  return null;
}

function summarizeToolResult(input) {
  const name = input.tool_name || "tool";
  const response = input.tool_response || {};
  const code = response.exit_code ?? response.status ?? response.code;
  if (code !== undefined && code !== 0 && code !== "0")
    return `${name} completed with non-zero result ${code}. Review output before marking completion.`;
  if (name === "apply_patch")
    return "Patch operation completed. Review changed files before marking the task done.";
  if (name === "Bash")
    return "Command completed. Use its output as evidence only if it directly validates the active route segment.";
  return `${name} completed and was recorded as route evidence.`;
}

function inferEvidenceKind(input) {
  const name = input.tool_name || "";
  const command = String(input.tool_input?.command || "");
  if (name === "apply_patch") return "file_change";
  if (isValidationCommand(command)) return "test_result";
  if (name === "Bash") return "command_result";
  return "tool_result";
}

function commandEvidenceForTool(input, workspaceRoot, sessionId = null, env) {
  const command = input.tool_input?.command || null;
  const files = changedFilesForTool(input);
  if (!command) return files.length ? { files } : {};
  const mode = commandCaptureMode(env);
  if (
    mode === "none" ||
    (mode === "validation-only" && !isValidationCommand(command))
  )
    return files.length ? { files } : {};
  const text = redactSensitiveText(command);
  if (text.length <= 800)
    return { command: text, ...(files.length ? { files } : {}) };
  const scratchRoot = workspaceScratchDir(workspaceRoot, sessionId);
  ensureDir(scratchRoot);
  const digest = crypto
    .createHash("sha256")
    .update(text)
    .digest("hex")
    .slice(0, 12);
  // Tool names originate with the host. Never place them in a filesystem path;
  // the evidence record can retain its safe human-facing description instead.
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-command-${digest}.txt`;
  const filePath = path.join(scratchRoot, fileName);
  atomicWriteText(filePath, text, { tempDir: workspaceTempDir(workspaceRoot) });
  const rel = relativeToWorkspace(workspaceRoot, filePath);
  return {
    command: `[omitted long ${input.tool_name || "tool"} input; saved to ${rel}]`,
    notes: { scratchFile: rel, originalLength: text.length },
    ...(files.length ? { files } : {}),
  };
}

function commandCaptureMode(env = {}) {
  const value = String(env.OTM_COMMAND_CAPTURE || "redacted")
    .trim()
    .toLowerCase();
  return ["redacted", "none", "validation-only"].includes(value)
    ? value
    : "redacted";
}

function changedFilesForTool(input) {
  const explicit =
    input.tool_response?.changed_files ||
    input.tool_response?.file_paths ||
    input.tool_input?.files;
  const values = Array.isArray(explicit) ? explicit : [];
  const patch = String(
    input.tool_input?.patch || input.tool_input?.input || "",
  );
  for (const match of patch.matchAll(
    /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm,
  ))
    values.push(match[1]);
  return [
    ...new Set(
      values
        .map((value) => String(value).trim())
        .filter(
          (value) => value && value.length <= 1024 && !value.includes("\0"),
        ),
    ),
  ];
}

function shouldRecordPostToolEvidence(input, env) {
  const name = input.tool_name || "";
  const command = String(input.tool_input?.command || "");
  if (name === "apply_patch") return true;
  if (name.startsWith("mcp__")) return env.OTM_TRACK_MCP_EVIDENCE === "1";
  if (name === "Bash") return isValidationCommand(command) || toolFailed(input);
  return toolFailed(input);
}

function isValidationCommand(command) {
  return /\b(test|lint|check|typecheck|build|vitest|jest|pytest|npm run|pnpm|yarn)\b/i.test(
    command,
  );
}

function toolFailed(input) {
  const response = input.tool_response || {};
  const code = response.exit_code ?? response.status ?? response.code;
  return code !== undefined && code !== 0 && code !== "0";
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return fallback;
  }
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return value;
}
