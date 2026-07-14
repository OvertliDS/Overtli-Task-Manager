import fs from "node:fs";
import path from "node:path";
import { resolveWithinRoot } from "../core/validation.mjs";
import { AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END } from "../core/constants.mjs";
import { readText, atomicWriteText, pathExists } from "../core/fs-utils.mjs";

export function managedAgentsBlock() {
  return [
    AGENTS_BLOCK_BEGIN,
    "## Overtli Task Manager protocol",
    "",
    "For every non-trivial Codex task in this workspace:",
    "",
    "1. Start or reconcile an Overtli Task Manager route before editing files or running implementation commands.",
    "2. When Codex exposes native goal controls, create one goal if this chat has no active goal. Its objective must cover every requested phase and task; keep it active until the OTM stop audit passes. Use the native terminal goal update only after completion or a genuine blocker, never as a progress substitute.",
    "3. Let OTM isolate routes by workspace and Codex session (`CODEX_THREAD_ID`); use the session-scoped `current.json` path returned by OTM tools. The top-level `current.json` is a multi-session index.",
    "4. Show modern Markdown progress snapshots in chat after route creation, steering changes, blocked work, validation, and finalization.",
    "5. Treat tasks as route segments: one active segment at a time unless the user explicitly requests parallel work.",
    "6. Before task-scoped OTM calls, use exact task ids from the latest OTM snapshot or its session-scoped `current.json`; never copy ids from another chat, the workspace index, memory, or prior route state.",
    "7. While working a route segment, mark each internal step complete with `otm_progress` as soon as that step has concrete evidence; do not wait until the end and backfill the internal checklist.",
    "8. Mark a segment done with `otm_complete_task` only after every required internal step is terminal (`done` or intentionally `skipped`) and segment-level evidence exists, such as changed files, command output, test results, document review, or user confirmation.",
    "9. If the user changes direction, reconcile the route immediately instead of continuing from stale assumptions.",
    "10. Before any final response, run the OTM stop audit. If required segments remain open, continue working instead of ending the turn.",
    "11. At completion, let the Stop hook automatically finalize, save the summary, clear active state, and return the saved summary for the final reply. If `OTM_STOP_AUTO_FINALIZE=0`, manually call `otm_finalize_turn`, show its Markdown summary, then call `otm_clear_current`.",
    "12. Prefer thorough completion over shallow progress. Do not introduce placeholder logic, intentionally incomplete code, or unverified assumptions unless the user explicitly requests a scaffold.",
    "",
    AGENTS_BLOCK_END,
  ].join("\n");
}

export function chooseAgentsFile(workspaceRoot, explicitTarget = null) {
  if (explicitTarget) return resolveWithinRoot(workspaceRoot, explicitTarget);
  return path.join(workspaceRoot, "AGENTS.md");
}

/** @param {any} options */
export function patchAgentsFile(options = {}) {
  const { workspaceRoot, targetFile = null, dryRun = false } = options;
  const filePath = chooseAgentsFile(workspaceRoot, targetFile);
  const before = readText(filePath, "");
  const block = managedAgentsBlock();
  const beginCount = markerCount(before, AGENTS_BLOCK_BEGIN);
  const endCount = markerCount(before, AGENTS_BLOCK_END);
  if (beginCount > 1 || endCount > 1) {
    return {
      ok: false,
      action: "conflict",
      filePath,
      reason:
        "Found duplicate OTM markers. Manual repair is required before automatic patching.",
    };
  }
  const begin = before.indexOf(AGENTS_BLOCK_BEGIN);
  const end = before.indexOf(AGENTS_BLOCK_END);
  let after;
  let action;

  if (begin >= 0 && end >= 0 && end > begin) {
    const blockEnd = end + AGENTS_BLOCK_END.length;
    after =
      `${before.slice(0, begin).trimEnd()}\n\n${block}\n${before.slice(blockEnd).trimStart()}`.trimEnd() +
      "\n";
    action = "updated";
  } else if (begin >= 0 || end >= 0) {
    return {
      ok: false,
      action: "conflict",
      filePath,
      reason:
        "Found only one OTM marker. Manual repair is required before automatic patching.",
    };
  } else if (!before.trim()) {
    after = `# AGENTS.md\n\n${block}\n`;
    action = "created";
  } else {
    after = `${before.trimEnd()}\n\n${block}\n`;
    action = "appended";
  }

  if (!dryRun && after !== before) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteText(filePath, after);
  }
  return {
    ok: true,
    action: after === before ? "unchanged" : action,
    filePath,
    dryRun,
    changed: after !== before,
    warning: agentsOverrideWarning(workspaceRoot, targetFile),
    preview: dryRun ? after : undefined,
  };
}

function markerCount(text, marker) {
  return String(text).split(marker).length - 1;
}

function agentsOverrideWarning(workspaceRoot, explicitTarget = null) {
  const override = path.join(workspaceRoot, "AGENTS.override.md");
  if (!pathExists(override) || !readText(override, "").trim()) return undefined;
  if (
    explicitTarget &&
    path.resolve(workspaceRoot, explicitTarget) === override
  )
    return undefined;
  return "AGENTS.override.md exists and was not patched. Run install with --agents-file AGENTS.override.md only when you explicitly want OTM to patch the override file.";
}
