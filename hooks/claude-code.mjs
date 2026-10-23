#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { classifyPrompt, stripHarnessFrames } from "../src/core/planner.mjs";
import { compactOneLine } from "../src/core/text-utils.mjs";
import { createProviderAdapter } from "../src/core/provider-adapter.mjs";
import { mapClaudeHookPayload } from "../src/core/provider-session.mjs";
import { loadHostEvidenceModule } from "../src/core/continuation.mjs";
import { findWorkspaceRoot } from "../src/core/fs-utils.mjs";
import { redactSensitiveText } from "../src/core/validation.mjs";
import { issueClaudeSessionCapability } from "../src/core/claude-capability.mjs";

const hookOptions = parseHookOptions(process.argv.slice(2));
if (hookOptions.stateDir) process.env.OTM_STATE_DIR = hookOptions.stateDir;
if (hookOptions.storage) process.env.OTM_STORAGE = hookOptions.storage;

async function main() {
  const hookPayload = readInput();
  if (
    hookPayload.hook_event_name === "Stop" &&
    hookPayload.stop_hook_active === true
  ) {
    process.stdout.write(
      `${JSON.stringify({ continue: true, suppressOutput: true })}\n`,
    );
    return;
  }
  let result;
  try {
    const mapped = mapClaudeHookPayload(hookPayload);
    const hostEvidenceModule = hookOptions.hostEvidenceModulePath
      ? await loadHostEvidenceModule(hookOptions.hostEvidenceModulePath)
      : null;
    const cwdWorkspaceRoot = findWorkspaceRoot(
      hookPayload.cwd || process.cwd(),
    );
    const needsCapability = ["SessionStart", "UserPromptSubmit"].includes(
      mapped.eventName,
    );
    let sessionCapability = null;
    if (needsCapability) {
      try {
        sessionCapability = issueClaudeSessionCapability({
          nativeSessionId: mapped.nativeSessionId,
          workspaceRoot: cwdWorkspaceRoot,
        });
      } catch (error) {
        const message = `OTM could not create a secure Claude tool capability. ${redactSensitiveText(error?.message || String(error))}`;
        result =
          mapped.eventName === "UserPromptSubmit"
            ? { decision: "block", reason: message }
            : {
                hookSpecificOutput: {
                  hookEventName: "SessionStart",
                  additionalContext: message,
                },
              };
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
    }
    const adapter = createProviderAdapter({
      provider: "claude",
      nativeSessionId: mapped.nativeSessionId,
      workspaceRoot: cwdWorkspaceRoot,
      inspectOwnerWork: hostEvidenceModule?.inspectOwnerWork || null,
    });
    try {
      // A Claude session keeps one route even when its cwd later moves into a
      // nested repository or another folder. The route this exact native
      // session owns fixes the workspace for every hook of that session.
      const owned = adapter.snapshot({
        workspaceRoot: cwdWorkspaceRoot,
        write: false,
      }).run;
      const workspaceRoot =
        owned?.metadata?.providerSession?.provider === "claude" &&
        owned.metadata.providerSession.nativeSessionId ===
          mapped.nativeSessionId &&
        typeof owned.workspaceRoot === "string"
          ? owned.workspaceRoot
          : cwdWorkspaceRoot;
      let observerDiagnostic = null;
      let hostObservation = null;
      if (
        hostEvidenceModule?.observeHostHook &&
        !(mapped.eventName === "Stop" && hookPayload.stop_hook_active === true)
      ) {
        try {
          const current = adapter.snapshot({ workspaceRoot, write: false });
          hostObservation = await hostEvidenceModule.observeHostHook({
            schemaVersion: "otm.host-hook-observation.v1",
            provider: "claude",
            eventName: mapped.eventName,
            payload: hookPayload,
            workspaceRoot,
            nativeSessionId: mapped.nativeSessionId,
            providerSessionKey: adapter.session.providerSessionKey,
            sessionId: adapter.session.sessionId,
            run: current.run || null,
            routeRevision: current.run?.routeRevision ?? null,
          });
        } catch (error) {
          const diagnostic = redactSensitiveText(
            error?.message || String(error),
          )
            .split(sessionCapability || "\u0000")
            .join("[session capability removed]");
          observerDiagnostic = `The configured host observer did not record this Claude hook event: ${diagnostic}`;
        }
      }
      if (
        mapped.eventName === "PreToolUse" &&
        isOdcBackgroundDispatch(hookPayload) &&
        hostObservation?.dispatchAllowed !== true
      ) {
        result = denyOdcDispatch(
          hostObservation?.code ||
            (observerDiagnostic
              ? "HOST_OBSERVER_FAILED"
              : "HOST_OBSERVER_UNAVAILABLE"),
        );
      } else {
        result = await handleClaudeHook(
          adapter,
          mapped,
          hookPayload,
          workspaceRoot,
          {
            hostEvidenceConfigured: Boolean(
              hostEvidenceModule?.observeHostHook,
            ),
            hostObservation,
            observerDiagnostic,
          },
        );
      }
      if (sessionCapability) {
        result = appendSessionCapability(
          result,
          mapped.eventName,
          sessionCapability,
        );
      }
      if (observerDiagnostic) {
        result = appendHookContext(
          result,
          mapped.eventName,
          observerDiagnostic,
        );
      }
    } finally {
      adapter.close();
    }
  } catch (error) {
    const message = redactSensitiveText(error?.message || String(error));
    if (
      hookPayload.hook_event_name === "PreToolUse" &&
      isOdcBackgroundDispatch(hookPayload)
    ) {
      result = denyOdcDispatch("HOST_OBSERVER_FAILED", message);
    } else if (hookPayload.hook_event_name === "Stop") {
      result =
        hookPayload.stop_hook_active === true
          ? { continue: true, suppressOutput: true }
          : {
              decision: "block",
              reason: `OTM could not verify safe stop/continuation state. ${message} Inspect the exact host jobs and route, then retry or explicitly cancel unfinished work.`,
            };
    } else if (hookPayload.hook_event_name === "UserPromptSubmit") {
      result = {
        decision: "block",
        reason: `OTM could not prepare the shared task route. ${message} Retry the prompt after the hook error is resolved.`,
      };
    } else if (hookPayload.hook_event_name === "SessionStart") {
      result = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `OTM could not load shared task context. ${message}`,
        },
      };
    } else {
      result = { continue: true, suppressOutput: true };
    }
  }
  process.stdout.write(
    `${JSON.stringify(result || { continue: true, suppressOutput: true })}\n`,
  );
}

await main();

function isOdcBackgroundDispatch(payload = {}) {
  const toolName = String(payload.tool_name || "");
  const prefix = "mcp__desktop-commander__";
  if (!toolName.startsWith(prefix)) return false;
  let operation = toolName.slice(prefix.length);
  const action = String(payload.tool_input?.action || "").toLowerCase();
  if (operation === "system_write") {
    operation = String(payload.tool_input?.operationId || "");
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
  return !["status", "output", "get", "list", "inspect", "search"].includes(
    action,
  );
}

function denyOdcDispatch(code, detail = "") {
  const reason = `OTM blocked this ODC background-work call because trusted owner coverage was not recorded (${code}). Resolve the host evidence issue, then retry the exact operation.${detail ? ` ${detail}` : ""}`;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

async function handleClaudeHook(
  adapter,
  mapped,
  payload,
  workspaceRoot,
  hostStatus = {},
) {
  const eventName = mapped.eventName;
  if (eventName === "Stop" && payload.stop_hook_active === true) {
    return { continue: true, suppressOutput: true };
  }

  if (eventName === "UserPromptSubmit") {
    const prompt = String(payload.prompt || "").trim();
    const continuation = prompt.match(/^\/otm\s+continue\s+(\S+)\s*$/i);
    if (continuation) {
      const shared = adapter.readSharedTask({
        runId: continuation[1],
        workspaceRoot,
      });
      const transferred = adapter.continueTask({
        runId: continuation[1],
        expectedRevision: shared.run.routeRevision,
        workspaceRoot,
      });
      adapter.observeHostHook({ eventName, payload, workspaceRoot });
      return hookMessage(
        `OTM transferred exclusive ownership at revision ${transferred.run.routeRevision}. Continue the existing shared route and its exact task IDs.\n\n${transferred.markdown}`,
        eventName,
      );
    }
    return handlePrompt(adapter, payload, workspaceRoot, prompt);
  }

  const observation = adapter.observeHostHook({
    eventName,
    payload,
    workspaceRoot,
  });
  if (eventName === "Stop") {
    if (!observation.recorded) return { continue: true, suppressOutput: true };
    const inventory = observation.events.find(
      (event) => event.eventType === "provider_work_inventory",
    );
    const status = inventory?.payload;
    if (!status?.complete || status.unknownWorkCount > 0) {
      const unmatchedCount = status?.unmatchedReceiptCount || 0;
      const onlyReceipts =
        Array.isArray(status?.unmatchedReceipts) &&
        unmatchedCount > 0 &&
        status.unknownWorkCount === unmatchedCount;
      if (onlyReceipts && status.activeWorkCount > 0) {
        // Claude still runs background work and re-invokes the session when
        // it ends; the next Stop re-checks these receipts. End the turn
        // without finalizing instead of forcing an idle turn.
        return { continue: true, suppressOutput: true };
      }
      if (onlyReceipts) {
        return {
          decision: "block",
          reason: `OTM cannot finalize this route: ${unmatchedCount} unmatched OTM hook work receipt(s) never received a terminal hook (${status.unmatchedReceipts.join(", ")}${unmatchedCount > status.unmatchedReceipts.length ? ", ..." : ""}) and Claude reports no running background work. A "subagent:" receipt means SubagentStop never arrived; a "tool:" receipt means neither PostToolUse nor a transcript tool_result was recorded. Wait for or stop that exact work in Claude, then retry Stop.`,
        };
      }
      return {
        decision: "block",
        reason: `OTM cannot close this turn while Claude reports unclassified background tasks/session crons${status?.inventoryReason ? ` (${status.inventoryReason})` : ""}. Wait for them or cancel them through Claude, then retry. A chat stop does not settle detached work.`,
      };
    }
    if (status.activeWorkCount > 0) {
      // Claude re-invokes the session when its own background tasks finish, so
      // blocking here only forces idle turns. End the turn without finalizing:
      // the route stays open until a later Stop sees no running work.
      return { continue: true, suppressOutput: true };
    }
    const current = adapter.snapshot({ write: false });
    if (!current.run) return { continue: true, suppressOutput: true };
    const hostBlocker = claudeStopHostBlocker(hostStatus);
    if (hostBlocker) {
      const mismatch = hostStatus.hostObservation?.mismatch;
      const detail =
        hostBlocker === "HOST_HOOK_IDENTITY_UNVERIFIED" && mismatch
          ? ` ${identityMismatchHelp(mismatch, workspaceRoot, current.run)}`
          : ["ODC_OWNER_COVERAGE_MISSING", "ODC_OWNER_COVERAGE_LEGACY"].includes(
                hostBlocker,
              )
            ? ` This Claude session has no owner coverage record: coverage begins only at a fresh SessionStart with source "startup", and replaying SessionStart cannot create it later. Continue route ${current.run.id} from a new Claude session with /otm continue ${current.run.id}.`
            : " Configure or repair the exact host observer, finish/cancel its recorded work, then retry Stop.";
      return {
        decision: "block",
        reason: `OTM cannot finalize this route while trusted owner-work coverage is missing, active, or unknown (${hostBlocker}${mismatch ? `: ${mismatch} mismatch` : ""}).${detail}`,
      };
    }
    const ownedWork = adapter.inspectOwnedWork({
      runId: current.run.id,
      workspaceRoot,
    });
    if (
      ownedWork.complete !== true ||
      ownedWork.activeWorkCount !== 0 ||
      ownedWork.unknownWorkCount !== 0
    ) {
      const code = /^[A-Z][A-Z0-9_-]{1,79}$/.test(ownedWork.code || "")
        ? ownedWork.code
        : "HOST_WORK_UNKNOWN";
      return {
        decision: "block",
        reason: `OTM cannot finalize this route while its trusted native-broker or ODC-job inspection reports active or unknown work (${code}; ${ownedWork.activeWorkCount ?? "?"} active, ${ownedWork.unknownWorkCount ?? "?"} unknown). Finish or cancel the exact owner work, refresh the evidence, then retry Stop.`,
      };
    }
    const audit = adapter.auditStop({ runId: current.run.id });
    if (!audit.stopAllowed) {
      return {
        decision: "block",
        reason: `Overtli Task Manager still has required route work: ${audit.stopReason || "complete the current route gates"}`,
      };
    }
    const finalized = adapter.finalizeTurn({
      runId: current.run.id,
      outcome: "completed",
      clearCurrent: true,
    });
    return hookMessage(
      `Overtli Task Manager saved the canonical route summary and cleared the completed current route.\n\n${finalized.markdown}`,
      eventName,
    );
  }

  if (eventName === "SessionStart") {
    const current = adapter.snapshot({ write: false });
    const coverageNote = sessionStartCoverageNote(
      hostStatus,
      payload,
      current.run,
    );
    if (current.run) {
      return hookMessage(
        `Overtli Task Manager loaded the shared canonical route. Keep ownership in this session and continue with its exact task IDs.\n\n${current.markdown}${coverageNote ? `\n\n${coverageNote}` : ""}`,
        eventName,
      );
    }
    if (coverageNote) return hookMessage(coverageNote, eventName);
    // SessionStart is a project-context hook, not a global history navigator.
    // Do not inject unrelated providers' active tasks into a fresh project.
    // Explicit cross-project continuation remains available via /otm continue <runId>.
    const shared = adapter.readSharedHistory({ workspaceRoot, scope: "workspace", limit: 20 });
    const active = shared.runs.filter((run) =>
      ["active", "ready_to_finalize", "blocked", "paused"].includes(run.status),
    );
    const context = active.length
      ? `Shared OTM history contains active routes in this project:\n${active
          .slice(0, 5)
          .map(
            (run) =>
              `- ${run.id} | ${run.status} | revision ${run.routeRevision} | ${run.metadata?.providerSession?.provider || "legacy owner"} | ${run.goal}`,
          )
          .join(
            "\n",
          )}\nTo request one, submit exactly: /otm continue <runId>. Transfer is explicit and remains blocked until recent activity and fresh native-broker and ODC-job evidence prove safe exclusive ownership.`
      : "Overtli Task Manager is available. Start a route through the OTM tools for substantial work; task history and summaries are shared across providers.";
    return hookMessage(context, eventName);
  }

  if (eventName === "PreCompact") {
    const current = adapter.snapshot({ workspaceRoot, write: false });
    if (current.run) {
      adapter.checkpoint({
        runId: current.run.id,
        workspaceRoot,
        checkpointKey: `claude-compact:${payload.trigger || "unknown"}:${current.run.routeRevision}`,
      });
    }
    return { continue: true, suppressOutput: true };
  }

  if (eventName === "PostCompact") {
    // PostCompact has no decision/context channel. Read the canonical route;
    // SessionStart(source=compact) injects refreshed OTM context and capability.
    adapter.snapshot({ workspaceRoot, write: false });
    return { continue: true, suppressOutput: true };
  }

  if (eventName === "SessionEnd") {
    return { continue: true, suppressOutput: true };
  }
  return { continue: true, suppressOutput: true };
}

function claudeStopHostBlocker({
  hostEvidenceConfigured,
  hostObservation,
  observerDiagnostic,
} = {}) {
  if (observerDiagnostic) return "HOST_OBSERVER_FAILED";
  if (!hostEvidenceConfigured) return "HOST_OBSERVER_UNAVAILABLE";
  if (hostObservation?.observed !== true) {
    return hostObservation?.code || "HOST_WORK_UNKNOWN";
  }
  const coverage = hostObservation.coverage;
  if (coverage?.complete !== true) {
    return coverage?.code || hostObservation.code || "HOST_WORK_UNKNOWN";
  }
  if (
    !Number.isSafeInteger(coverage.pendingCount) ||
    coverage.pendingCount < 0
  ) {
    return "HOST_WORK_UNKNOWN";
  }
  return coverage.pendingCount > 0 ? "ODC_WORK_PENDING" : null;
}

/**
 * SessionStart never blocks, so explain when it could not establish trusted
 * owner coverage instead of returning silently. Coverage starts only at a
 * fresh `startup`; replaying resume/compact/clear for a session that already
 * ran unobserved (or for an unknown session id) creates no state.
 */
function sessionStartCoverageNote(
  { hostEvidenceConfigured, hostObservation } = {},
  payload,
  run,
) {
  if (!hostEvidenceConfigured || !hostObservation) return null;
  if (hostObservation.coverage?.complete === true) return null;
  const code = hostObservation.code || "HOST_WORK_UNKNOWN";
  if (code === "ODC_OWNER_COVERAGE_LEGACY") {
    return run
      ? `OTM host coverage is not recorded for this Claude session (${code}). Coverage begins only at a fresh SessionStart with source "startup"; this "${payload.source || "unknown"}" start cannot create it, so Stop cannot finalize route ${run.id} from this session. Finish the gates, then continue the route from a new Claude session with /otm continue ${run.id}.`
      : `OTM recorded nothing for Claude session ${payload.session_id}: no route is owned by it and host coverage begins only at a SessionStart with source "startup" (${code}). If you replayed this hook by hand, use the session_id of the live session that owns the route.`;
  }
  return `OTM host coverage for this Claude session is incomplete (${code}${hostObservation.mismatch ? `: ${hostObservation.mismatch} mismatch` : ""}); Stop will not finalize a route until it is repaired.`;
}

function identityMismatchHelp(mismatch, workspaceRoot, run) {
  if (mismatch === "workspaceRoot")
    return `The Stop hook resolved workspace ${workspaceRoot}, but route ${run?.id} belongs to ${run?.workspaceRoot}. Return the session to the route's folder (or finish the route there), then retry Stop.`;
  if (mismatch === "routeOwner" || mismatch === "session_id")
    return `This Stop hook's Claude session does not own route ${run?.id}. Continue it explicitly with /otm continue ${run?.id} from the owning session, or let the owner finish it.`;
  if (mismatch === "routeRevision")
    return "The route changed while the hook was reading it. Retry Stop.";
  return "Claude sent a hook payload whose identity fields do not match this session. Retry Stop; if it repeats, reconnect the session so SessionStart re-establishes coverage.";
}

function handlePrompt(adapter, payload, workspaceRoot, rawPrompt) {
  // Subagent hand-backs, task notifications and reminders arrive through
  // UserPromptSubmit too; they must not start routes or reopen contract review.
  const prompt = stripHarnessFrames(rawPrompt);
  if (!prompt) return { continue: true, suppressOutput: true };
  adapter.observeHostHook({
    eventName: "UserPromptSubmit",
    payload,
    workspaceRoot,
  });
  const current = adapter.snapshot({ write: false });
  const classification = classifyPrompt(prompt, Boolean(current.run));
  if (classification === "simple" || classification === "empty") {
    return { continue: true, suppressOutput: true };
  }
  if (!current.run && classification === "new_route") {
    const started = adapter.startTask({
      workspaceRoot,
      goal: compactOneLine(prompt, 180) || "Complete the requested task",
      prompt,
      source: "claude-hook-auto-start",
      hookEventName: "UserPromptSubmit",
      invocationId: payload.tool_use_id || payload.invocation_id || null,
    });
    return hookMessage(
      `OTM created the shared canonical route. Review the outcome gates and exact task IDs before implementation.\n\n${started.markdown}`,
      "UserPromptSubmit",
    );
  }
  if (!current.run) {
    return { continue: true, suppressOutput: true };
  }
  const reconciled = adapter.reconcileTask({
    workspaceRoot,
    runId: current.run.id,
    mode: classification === "continue" ? "continue" : "steer",
    prompt,
    hookEventName: "UserPromptSubmit",
    invocationId: payload.tool_use_id || payload.invocation_id || null,
  });
  return hookMessage(
    `OTM reconciled the current shared route to this prompt. Preserve completed evidence and continue with its exact task IDs.\n\n${reconciled.markdown}`,
    "UserPromptSubmit",
  );
}

function hookMessage(additionalContext, eventName) {
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: eventName, additionalContext },
  };
}

function appendSessionCapability(result, eventName, capability) {
  const prior = result?.hookSpecificOutput?.additionalContext || "";
  const context = [
    prior,
    "OTM Claude MCP session capability (short-lived; pass only as the `sessionCapability` argument to OTM tools):",
    capability,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...result,
    hookSpecificOutput: {
      ...(result?.hookSpecificOutput || {}),
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

function appendHookContext(result, eventName, additionalContext) {
  const supported = new Set([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
  ]);
  if (!supported.has(eventName)) return result;
  const prior = result?.hookSpecificOutput?.additionalContext || "";
  return {
    ...result,
    hookSpecificOutput: {
      ...(result?.hookSpecificOutput || {}),
      hookEventName: eventName,
      additionalContext: [prior, additionalContext]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}

function readInput() {
  const input = fs.readFileSync(0, "utf8");
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed;
  } catch {
    return {};
  }
}

function parseHookOptions(args) {
  const options = {};
  const allowed = new Set([
    "--host-evidence-module",
    "--state-dir",
    "--storage",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.has(option) || !value || value.startsWith("--")) {
      throw new Error(
        `Invalid Claude OTM hook argument: ${option || "(missing)"}.`,
      );
    }
    if (Object.hasOwn(options, option)) {
      throw new Error(`Duplicate Claude OTM hook argument: ${option}.`);
    }
    options[option] = value;
  }
  const stateDir = options["--state-dir"];
  if (stateDir && !path.isAbsolute(stateDir)) {
    throw new Error("OTM state directory must be absolute.");
  }
  const storage = options["--storage"];
  if (storage && !new Set(["auto", "sqlite", "json"]).has(storage)) {
    throw new Error("OTM storage must be auto, sqlite, or json.");
  }
  const hostEvidenceModulePath = options["--host-evidence-module"];
  if (hostEvidenceModulePath && !path.isAbsolute(hostEvidenceModulePath)) {
    throw new Error("Host evidence module path must be absolute.");
  }
  return {
    stateDir: stateDir ? path.resolve(stateDir) : null,
    storage: storage || null,
    hostEvidenceModulePath: hostEvidenceModulePath
      ? path.resolve(hostEvidenceModulePath)
      : null,
  };
}
