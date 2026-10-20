import { OtmError } from "./errors.mjs";

const PAGE_SIZE = 10;

function integer(value, fallback, maximum, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum)
    throw new OtmError(`${name} is outside its supported range.`, {
      code: "INVALID_INPUT",
    });
  return result;
}

export function historyRun(run) {
  const owner = run.metadata?.providerSession;
  return {
    id: run.id,
    goal: String(run.goal || "").slice(0, 300),
    status: run.status,
    workspaceRoot: run.workspaceRoot,
    sessionId: run.sessionId,
    routeRevision: run.routeRevision,
    currentTaskId: run.currentTaskId,
    updatedAt: run.updatedAt,
    owner: owner
      ? {
          provider: owner.provider,
          nativeSessionId: owner.nativeSessionId,
          verifiedProviderRecord: true,
        }
      : {
          provider: run.sessionId?.startsWith("otm-provider:claude:v1:")
            ? "claude"
            : run.sessionId
              ? "codex"
              : null,
          nativeSessionId: run.sessionId,
          verifiedProviderRecord: false,
        },
  };
}

function historySummary(summary) {
  const text = String(summary.summaryMd || "");
  return {
    id: summary.id,
    runId: summary.runId,
    workspaceRoot: summary.workspaceRoot,
    createdAt: summary.createdAt,
    characterCount: text.length,
    preview: text.slice(0, 160),
  };
}

/** Same-user canonical history, independent of the current provider or folder. */
export function readSharedHistoryPage(store, input, workspaceRoot) {
  const offset = integer(input.offset, 0, 10_000_000, "offset");
  const requestedLimit = integer(input.limit, PAGE_SIZE, 50, "limit");
  if (!requestedLimit)
    throw new OtmError("limit must be positive.", { code: "INVALID_INPUT" });
  const limit = Math.min(requestedLimit, PAGE_SIZE);
  const scope = input.scope || "all";
  if (!["all", "workspace"].includes(scope))
    throw new OtmError("scope must be all or workspace.", {
      code: "INVALID_INPUT",
    });
  const run = input.runId ? store.getRun(input.runId) : null;
  if (input.runId && !run)
    throw new OtmError("Saved run not found.", { code: "RUN_NOT_FOUND" });
  if (input.summaryId) {
    if (!run)
      throw new OtmError("runId is required to read a saved summary.", {
        code: "RUN_ID_REQUIRED",
      });
    const summary = store.getSummary(input.summaryId);
    if (!summary || summary.runId !== run.id)
      throw new OtmError("Saved summary does not belong to this run.", {
        code: "SUMMARY_NOT_FOUND",
      });
    const text = String(summary.summaryMd || "");
    const maxChars = integer(input.maxChars, 4_000, 12_000, "maxChars");
    if (!maxChars)
      throw new OtmError("maxChars must be positive.", {
        code: "INVALID_INPUT",
      });
    const end = Math.min(text.length, offset + maxChars);
    return {
      run: historyRun(run),
      summary: {
        ...historySummary(summary),
        offset,
        text: text.slice(offset, end),
        nextOffset: end < text.length ? end : null,
        complete: end >= text.length,
      },
    };
  }
  const workspace = scope === "workspace" ? workspaceRoot : null;
  const runs = run ? [run] : store.listRuns(workspace, limit + 1, offset);
  const summaries = run
    ? store.listSummariesForRun(run.id, limit + 1, offset)
    : store.listSummaries(workspace, limit + 1, offset);
  return {
    scope,
    offset,
    limit,
    runs: runs.slice(0, limit).map(historyRun),
    summaries: summaries.slice(0, limit).map(historySummary),
    nextOffset:
      runs.length > limit || summaries.length > limit ? offset + limit : null,
    guidance:
      "Use otm_snapshot with an exact runId to inspect its shared route. Read a saved summary with this tool's runId, summaryId, offset and maxChars; no provider-specific summary is required. Folder location does not grant or block ownership. Use otm_continue only for an explicit safe ownership transfer.",
  };
}
