/**
 * Owner-scoped host work evidence for one route.
 *
 * Stop gates and continuation only need, for one owner session, the latest
 * activity receipt and the latest receipt of every host work id. Replaying the
 * full event history answers the same question but grows without bound, so a
 * capped snapshot of a long route can never prove its work settled. These
 * helpers keep exactly the receipts that decide the outcome:
 * findPendingWorkEntries over the compact list equals the result over the full
 * history, and the latest owner activity receipt is preserved.
 */

export const OWNER_WORK_EVENT_TYPES = Object.freeze([
  "provider_session_activity",
  "provider_host_work_started",
  "provider_host_work_settled",
]);

export function isOwnerEvent(event, owner) {
  return (
    event?.payload?.ownerSessionId === owner?.ownerSessionId &&
    event?.payload?.providerSessionKey === owner?.providerSessionKey
  );
}

/** Group key: one slot for activity, one per work id, one per id-less receipt. */
function evidenceKey(event) {
  if (event.eventType === "provider_session_activity") return "activity";
  const workId = event.payload?.workId;
  if (typeof workId === "string" && workId) return `work:${workId}`;
  return `event:${event.id}`;
}

/**
 * Reduce chronologically ordered events to the latest decisive receipt per
 * key for one owner, returned in chronological order.
 */
export function compactOwnerWorkEvents(events, owner) {
  const latest = new Map();
  for (const event of events) {
    if (!OWNER_WORK_EVENT_TYPES.includes(event?.eventType)) continue;
    if (!isOwnerEvent(event, owner)) continue;
    const key = evidenceKey(event);
    latest.delete(key);
    latest.set(key, event);
  }
  return [...latest.values()];
}

/**
 * Complete owner work evidence from a store, or null when completeness cannot
 * be proved. Stores with a dedicated query never truncate; older stores fall
 * back to a capped snapshot and fail closed when it is truncated.
 */
export function readOwnerWorkEvidence(store, runId, owner) {
  if (typeof store?.getOwnerWorkEvidence === "function") {
    const events = store.getOwnerWorkEvidence(runId, owner);
    return Array.isArray(events) ? events : null;
  }
  const history = store?.getEventSnapshot?.(runId, 10_000);
  if (
    !history ||
    !Array.isArray(history.events) ||
    !Number.isSafeInteger(history.totalCount) ||
    history.totalCount < 0 ||
    history.events.length !== history.totalCount
  ) {
    return null;
  }
  return compactOwnerWorkEvents(history.events, owner);
}
