import fs from "node:fs";
import path from "node:path";
import { readText, atomicWriteText } from "../core/fs-utils.mjs";

const EVENT_COMMANDS = {
  SessionStart: {
    matcher: "startup|resume|compact",
    statusMessage: "Loading OTM route",
    event: "session-start",
    timeout: 15,
  },
  UserPromptSubmit: {
    statusMessage: "Mapping route",
    event: "user-prompt-submit",
    timeout: 12,
  },
  PreToolUse: {
    matcher: "Bash|apply_patch",
    event: "pre-tool-use",
    timeout: 8,
  },
  PostToolUse: {
    matcher: "Bash|apply_patch",
    event: "post-tool-use",
    timeout: 12,
  },
  PreCompact: {
    matcher: "manual|auto",
    statusMessage: "Saving route",
    event: "pre-compact",
    timeout: 15,
  },
  PostCompact: {
    matcher: "manual|auto",
    statusMessage: "Restoring route",
    event: "post-compact",
    timeout: 15,
  },
  Stop: { statusMessage: "Auditing completion", event: "stop", timeout: 45 },
};

/** @param {any} options */
export function patchHooksJson(options = {}) {
  const {
    workspaceRoot,
    packageRoot,
    targetFile = null,
    dryRun = false,
  } = options;
  const filePath = targetFile
    ? path.resolve(targetFile)
    : path.join(workspaceRoot, ".codex", "hooks.json");
  const before = readText(filePath, "");
  let doc;
  try {
    doc = before.trim() ? JSON.parse(before) : { hooks: {} };
  } catch (_error) {
    return {
      ok: false,
      action: "invalid-json",
      filePath,
      reason: "hooks.json is malformed. Installation was not applied.",
      errorCode: "HOOKS_JSON_INVALID",
    };
  }
  if (
    !doc ||
    typeof doc !== "object" ||
    Array.isArray(doc) ||
    (doc.hooks !== undefined &&
      (!doc.hooks || typeof doc.hooks !== "object" || Array.isArray(doc.hooks)))
  ) {
    return {
      ok: false,
      action: "invalid-json",
      filePath,
      reason:
        "hooks.json must contain an object-valued hooks property. Installation was not applied.",
      errorCode: "HOOKS_JSON_INVALID",
    };
  }
  if (!doc.hooks) doc.hooks = {};
  for (const [eventName, spec] of Object.entries(EVENT_COMMANDS)) {
    const command = `node ${quoteCommandArg(path.join(packageRoot, "bin", "otm.mjs"))} hook ${spec.event}`;
    const entry = {
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [
        {
          type: "command",
          command,
          ...(spec.timeout ? { timeout: spec.timeout } : {}),
          ...(spec.statusMessage ? { statusMessage: spec.statusMessage } : {}),
        },
      ],
    };
    const existing = Array.isArray(doc.hooks[eventName])
      ? doc.hooks[eventName]
      : [];
    const filtered = existing.map(removeOtmHooksFromEntry).filter(Boolean);
    filtered.push(entry);
    doc.hooks[eventName] = filtered;
  }
  const after = `${JSON.stringify(doc, null, 2)}\n`;
  const changed = after !== before;
  if (!dryRun && changed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteText(filePath, after);
  }
  return {
    ok: true,
    filePath,
    dryRun,
    action: changed ? "updated" : "unchanged",
    changed,
    hooksInstalled: Object.keys(EVENT_COMMANDS),
    preview: dryRun ? doc : undefined,
  };
}

function quoteCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * Return a hook entry without OTM-owned command hooks.  This deliberately
 * examines the documented hook shape instead of scanning JSON text: a user
 * comment, status message, or unrelated command mentioning "otm.mjs" must
 * never be deleted or replaced by an installation.
 */
export function removeOtmHooksFromEntry(entry) {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    !Array.isArray(entry.hooks)
  )
    return entry;
  const hooks = entry.hooks.filter((hook) => !isOtmHookCommand(hook?.command));
  return hooks.length ? { ...entry, hooks } : null;
}

export function isOtmHookCommand(command) {
  if (typeof command !== "string") return false;
  // Managed commands always invoke this package's bin/otm.mjs followed by the
  // hook subcommand. Permit either slash style and an explicitly quoted path,
  // but require a whole command rather than substring matching.
  return /^(?:node(?:\.exe)?|["'][^"']*node(?:\.exe)?["'])\s+(?:"[^"]*[\\/]bin[\\/]otm\.mjs"|[^\s]*[\\/]bin[\\/]otm\.mjs)\s+hook\s+[a-z][a-z-]*(?:\s.*)?$/i.test(
    command.trim(),
  );
}

export function removeOtmHooksDocument(doc) {
  if (
    !doc ||
    typeof doc !== "object" ||
    Array.isArray(doc) ||
    !doc.hooks ||
    typeof doc.hooks !== "object" ||
    Array.isArray(doc.hooks)
  ) {
    throw new Error("hooks.json must contain an object-valued hooks property.");
  }
  const next = { ...doc, hooks: { ...doc.hooks } };
  const removed = [];
  for (const [eventName, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) continue;
    const filtered = entries.map(removeOtmHooksFromEntry).filter(Boolean);
    if (filtered.length !== entries.length) removed.push(eventName);
    if (filtered.length) next.hooks[eventName] = filtered;
    else delete next.hooks[eventName];
  }
  return { doc: next, removed };
}
