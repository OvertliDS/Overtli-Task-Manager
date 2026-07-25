import fs from "node:fs";
import path from "node:path";
import { resolveWithinRoot } from "../core/validation.mjs";
import { AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END } from "../core/constants.mjs";
import { readText, atomicWriteText, pathExists } from "../core/fs-utils.mjs";

export function managedAgentsBlock() {
  return [
    AGENTS_BLOCK_BEGIN,
    "",
    "## Overtli Task Manager protocol",
    "",
    "For every non-trivial Codex task in this workspace:",
    "",
    "1. Before implementation, review the complete accumulated user contract and start or reconcile an Overtli Task Manager route.",
    "2. Map work into a model-authored three-tier hierarchy: major outcome gates (`tasks`), substantive explicit or inferred subtasks (`internalSteps`), and concrete mini-steps for each non-atomic subtask. Tag every gate by its actual work type when prompts mix planning, review, research, documentation, implementation, validation, release, operations, or other justified work. Preserve explicit wording, identifiers, order, constraints, and acceptance conditions; the model owns domain interpretation.",
    "3. Never reuse a canned checklist. Treat deterministic planning only as a visible model-review scaffold and reconcile it into outcome-specific structure before implementation.",
    "4. When native goal controls are available, keep one goal covering the whole request active until the OTM stop audit passes or a genuine blocker is recorded.",
    "5. Use the session-scoped snapshot returned by OTM and exact current task, internal-step, and mini-step ids. Record descendant progress as evidence becomes available, and close a gate only after its required descendants and gate evidence are complete.",
    "6. When the user steers, append the new context, re-review the whole accumulated contract, and reconcile before continuing while preserving still-valid state and evidence.",
    "7. Preserve unrelated user work. Complete every affected implementation, integration, validation, and documentation surface required by the request before claiming the gate is done.",
    "8. Prefer thorough completion over shallow progress. Do not introduce placeholder logic, intentionally incomplete code, or unverified assumptions unless the user explicitly requests a scaffold.",
    "9. Keep progress visible after route creation, steering, blockers, validation, and finalization. Before the final response, run the OTM stop audit and continue if required work remains.",
    "10. Let the Stop hook finalize and clear automatically by default. When automatic finalization is disabled, finalize explicitly, show the summary, and clear current state. Use the packaged Overtli Task Manager skill for detailed schemas, recovery, and troubleshooting.",
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
