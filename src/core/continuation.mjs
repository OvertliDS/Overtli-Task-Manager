import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OtmError } from "./errors.mjs";

export const CONTINUATION_MIN_IDLE_MS = 15 * 60 * 1000;
export const HOST_CONTINUATION_EVIDENCE_SCHEMA =
  "otm.host-continuation-evidence.v1";
export const HOST_CONTINUATION_REQUIRED_SOURCES = Object.freeze([
  "native-broker",
  "odc-jobs",
]);
const ACTIVE_RUN_STATUSES = new Set([
  "active",
  "ready_to_finalize",
  "blocked",
  "paused",
]);

/**
 * Decide whether recorded host observations are sufficient to offer a route
 * for explicit exclusive continuation. Missing observations are unknown.
 */
export function evaluateContinuation({
  run,
  events,
  now = Date.now(),
  minIdleMs = CONTINUATION_MIN_IDLE_MS,
  hostEvidence = null,
} = {}) {
  if (!run || !ACTIVE_RUN_STATUSES.has(run.status)) {
    return denied(
      "Only an active OTM route can be continued.",
      "RUN_NOT_ACTIVE",
    );
  }

  const providerSession = run.metadata?.providerSession;
  if (
    !providerSession?.provider ||
    !providerSession?.providerSessionKey ||
    !providerSession?.nativeSessionId
  ) {
    return denied(
      "The prior route owner has no verified provider-session record. Keep it with its current owner or use the host's explicit recovery/handoff flow.",
      "OWNER_ACTIVITY_UNKNOWN",
    );
  }

  const ownerEvents = (Array.isArray(events) ? events : []).filter(
    (event) =>
      event?.payload?.ownerSessionId === run.sessionId &&
      event?.payload?.providerSessionKey === providerSession.providerSessionKey,
  );
  const lastActivity = ownerEvents
    .filter((event) => event.eventType === "provider_session_activity")
    .at(-1);
  if (!lastActivity) {
    return denied(
      "No durable activity receipt exists for the prior owner. Use an explicit host handoff or recover the prior session's state before continuing.",
      "OWNER_ACTIVITY_UNKNOWN",
    );
  }
  const lastActivityMs = Date.parse(lastActivity.createdAt || "");
  if (!Number.isFinite(lastActivityMs) || lastActivityMs > now) {
    return denied(
      "The prior owner's activity timestamp is invalid. Inspect the saved OTM events before continuing.",
      "OWNER_ACTIVITY_INVALID",
    );
  }
  const idleMs = now - lastActivityMs;
  if (idleMs < minIdleMs) {
    return denied(
      `The prior owner was active ${formatAge(idleMs)} ago. Wait at least ${Math.ceil(minIdleMs / 60_000)} minutes after its last host activity, then inspect the exact work receipts again.`,
      "OWNER_RECENTLY_ACTIVE",
    );
  }

  const pendingWork = findPendingWork(ownerEvents);
  if (pendingWork.length) {
    return denied(
      `The prior owner has unfinished or unmatched host work (${pendingWork.slice(0, 4).join(", ")}). Finish or cancel it in the owning host and record actual terminal receipts before continuing.`,
      "OWNER_WORK_ACTIVE",
    );
  }

  const hostBlocker = hostEvidenceBlocker(hostEvidence);
  if (hostBlocker) {
    return denied(
      `The trusted host inspection could not prove the prior owner's work settled (${hostBlocker}). Resolve that exact host-evidence blocker, then inspect the durable work receipts again before continuing.`,
      hostBlocker,
    );
  }

  const evidence = validateHostContinuationEvidence(hostEvidence, {
    run,
    owner: providerSession,
    lastActivityAt: lastActivity.createdAt,
    lastActivityEventId: lastActivity.id,
    now,
  });
  if (!evidence) {
    return denied(
      "The prior host's task-owned work could not be proved settled. Inspect its native broker state, ODC jobs, task-owned resource claims, and durable receipts, then use the host's explicit handoff/recovery path. A stopped chat or stale route timestamp is not enough.",
      "OWNER_WORK_UNKNOWN",
    );
  }
  if (evidence.activeWorkCount > 0 || evidence.unknownWorkCount > 0) {
    return denied(
      `The prior host still reports active or unclassified work (${evidence.activeWorkCount} active, ${evidence.unknownWorkCount} unknown). Finish or cancel those exact jobs and refresh the durable inspection.`,
      "OWNER_WORK_ACTIVE",
    );
  }

  return {
    eligible: true,
    code: "CONTINUATION_ELIGIBLE",
    idleMs,
    evidenceSource: "host-inspection-composite",
    evidenceObservedAt: evidence.observedAt,
    evidenceRefs: evidence.evidenceRefs,
    lastActivityEventId: lastActivity.id,
    ownerProvider: providerSession.provider,
    ownerProviderSessionKey: providerSession.providerSessionKey,
  };
}

function hostEvidenceBlocker(evidence) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    evidence.complete !== false ||
    !Array.isArray(evidence.blockers)
  ) {
    return null;
  }
  return (
    evidence.blockers.find(
      (blocker) =>
        typeof blocker === "string" && /^[A-Z][A-Z0-9_-]{1,79}$/.test(blocker),
    ) || null
  );
}

/** Load trusted, locally configured OTM host callbacks for command hooks. */
export async function loadHostEvidenceModule(modulePath) {
  if (
    typeof modulePath !== "string" ||
    !modulePath.trim() ||
    !path.isAbsolute(modulePath)
  ) {
    throw new OtmError(
      "Host evidence module path must be an absolute configured path.",
      {
        code: "HOST_EVIDENCE_MODULE_PATH_INVALID",
      },
    );
  }
  const resolved = path.resolve(modulePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new OtmError("Host evidence module must be a regular local file.", {
      code: "HOST_EVIDENCE_MODULE_INVALID",
    });
  }
  const loaded = await import(pathToFileURL(resolved).href);
  const inspectOwnerWork =
    loaded.inspectOwnerWork ||
    (typeof loaded.default === "function" ? loaded.default : null) ||
    loaded.default?.inspectOwnerWork ||
    null;
  const observeHostHook =
    loaded.observeHostHook || loaded.default?.observeHostHook || null;
  if (
    (inspectOwnerWork !== null && typeof inspectOwnerWork !== "function") ||
    (observeHostHook !== null && typeof observeHostHook !== "function") ||
    (!inspectOwnerWork && !observeHostHook)
  ) {
    throw new OtmError(
      "Host evidence module must export inspectOwnerWork() or observeHostHook().",
      {
        code: "HOST_EVIDENCE_MODULE_INVALID",
      },
    );
  }
  return Object.freeze({ inspectOwnerWork, observeHostHook });
}

/** Load the continuation inspector required by provider adapters. */
export async function loadHostEvidenceInspector(modulePath) {
  const module = await loadHostEvidenceModule(modulePath);
  if (typeof module.inspectOwnerWork !== "function") {
    throw new OtmError("Host evidence module must export inspectOwnerWork().", {
      code: "HOST_EVIDENCE_MODULE_INVALID",
    });
  }
  return module.inspectOwnerWork;
}

export function validateHostContinuationEvidence(
  evidence,
  { run, owner, lastActivityAt, lastActivityEventId, now = Date.now() } = {},
) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
    return null;
  const observedAtMs = Date.parse(evidence.observedAt || "");
  const lastActivityMs = Date.parse(lastActivityAt || "");
  const age = now - observedAtMs;
  if (
    evidence.schemaVersion !== HOST_CONTINUATION_EVIDENCE_SCHEMA ||
    evidence.complete !== true ||
    evidence.runId !== run?.id ||
    evidence.routeRevision !== run?.routeRevision ||
    evidence.lastActivityAt !== lastActivityAt ||
    evidence.activityEventId !== lastActivityEventId ||
    !sameOwner(evidence.owner, owner) ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 60_000 ||
    !Number.isFinite(lastActivityMs) ||
    observedAtMs < lastActivityMs ||
    !Array.isArray(evidence.sources) ||
    !Array.isArray(evidence.blockers) ||
    evidence.blockers.length !== 0
  ) {
    return null;
  }

  const ids = new Set();
  const evidenceRefs = [];
  let activeWorkCount = 0;
  let unknownWorkCount = 0;
  for (const source of evidence.sources) {
    if (
      !HOST_CONTINUATION_REQUIRED_SOURCES.includes(source?.id) ||
      ids.has(source.id) ||
      source.status !== "complete" ||
      source.ownerSessionId !== owner.nativeSessionId ||
      !fresh(source.observedAt, now) ||
      Date.parse(source.observedAt) < lastActivityMs ||
      !nonnegativeCount(source.activeWorkCount) ||
      !nonnegativeCount(source.unknownWorkCount) ||
      !Array.isArray(source.evidenceRefs) ||
      source.evidenceRefs.length === 0
    ) {
      return null;
    }
    ids.add(source.id);
    activeWorkCount += source.activeWorkCount;
    unknownWorkCount += source.unknownWorkCount;
    for (const ref of source.evidenceRefs) {
      if (
        !ref ||
        typeof ref.recordId !== "string" ||
        !ref.recordId.trim() ||
        ref.ownerSessionId !== owner.nativeSessionId ||
        !fresh(ref.observedAt, now) ||
        Date.parse(ref.observedAt) < lastActivityMs ||
        typeof ref.path !== "string" ||
        !ref.path.trim() ||
        typeof ref.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(ref.sha256)
      ) {
        return null;
      }
      evidenceRefs.push({
        source: source.id,
        path: ref.path,
        sha256: ref.sha256,
      });
    }
  }
  if (
    HOST_CONTINUATION_REQUIRED_SOURCES.some((id) => !ids.has(id)) ||
    evidence.activeWorkCount !== activeWorkCount ||
    evidence.unknownWorkCount !== unknownWorkCount ||
    !nonnegativeCount(evidence.activeWorkCount) ||
    !nonnegativeCount(evidence.unknownWorkCount)
  ) {
    return null;
  }
  return {
    observedAt: evidence.observedAt,
    activeWorkCount,
    unknownWorkCount,
    evidenceRefs,
  };
}

function sameOwner(left, right) {
  return (
    left?.provider === right?.provider &&
    left?.providerSessionKey === right?.providerSessionKey &&
    left?.nativeSessionId === right?.nativeSessionId
  );
}

function fresh(value, now) {
  const observedAt = Date.parse(value || "");
  return (
    Number.isFinite(observedAt) &&
    observedAt <= now &&
    now - observedAt <= 60_000
  );
}

function nonnegativeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function findPendingWork(events) {
  return findPendingWorkEntries(events).map(([, label]) => label);
}

/** Open host work receipts as [workId, label] pairs, in start order. */
export function findPendingWorkEntries(events) {
  const open = new Map();
  for (const event of events) {
    const payload = event.payload || {};
    if (event.eventType === "provider_host_work_started") {
      if (typeof payload.workId === "string" && payload.workId) {
        open.set(payload.workId, payload.workLabel || payload.workId);
      } else {
        open.set(`unknown:${event.id}`, "work without host job id");
      }
    } else if (event.eventType === "provider_host_work_settled") {
      if (typeof payload.workId === "string") open.delete(payload.workId);
    }
  }
  return [...open.entries()];
}

/**
 * Resolve a trusted local host inspector for entry points without a hook
 * argument channel. An explicit module overrides the bundled reader; absent
 * config means no inspector and continuation must remain unavailable.
 */
export function resolveHostEvidenceModulePath(env = process.env) {
  const configuredModule = env.OTM_HOST_EVIDENCE_MODULE;
  if (typeof configuredModule === "string" && configuredModule.trim()) {
    return configuredModule;
  }
  const configPath =
    env.OTM_HOST_EVIDENCE_CONFIG ||
    path.join(
      os.homedir(),
      ".claude",
      "overtli-task-manager",
      "host-evidence.json",
    );
  if (!path.isAbsolute(configPath)) return null;
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return fileURLToPath(new URL("./local-host-evidence.mjs", import.meta.url));
}

function denied(reason, code) {
  return { eligible: false, code, reason };
}

function formatAge(milliseconds) {
  const minutes = Math.max(1, Math.floor(milliseconds / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function assertContinuationEligible(result) {
  if (!result?.eligible) {
    throw new OtmError(
      result?.reason || "Safe continuation could not be established.",
      {
        code: result?.code || "OWNER_WORK_UNKNOWN",
      },
    );
  }
  return result;
}
