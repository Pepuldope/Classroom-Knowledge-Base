// kb-autosync.js — when the corpus should refresh itself.
//
// Building from Classroom used to be entirely manual: a button, a progress
// card, a minute of waiting. That is the right shape for the FIRST build, which
// reads every course and every year, and the wrong shape for keeping up with a
// school week, where the answer is usually "one new assignment".
//
// So the decision is made here rather than offered as a setting: the app works
// out what it needs and does it.
//
//   none        the corpus is current enough, or we are in no position to sync
//   background  top it up quietly while the student uses the app
//   manual      too much has changed to do silently — ask
//
// Pure and DOM-free so every branch is testable.

const HOUR = 3600_000;

/** Refresh quietly once the corpus is this old. */
export const AUTO_SYNC_AFTER_HOURS = 6;
/** Past this, a silent sync is no longer a top-up; ask before spending it. */
export const MANUAL_SYNC_AFTER_DAYS = 30;
/** After a failed attempt, wait this long before trying again. */
export const RETRY_AFTER_MINUTES = 60;

export function kbAutoSyncModel({
  hasCorpus = false,
  lastSyncAt = null,
  lastAttemptAt = null,
  now = Date.now(),
  online = true,
  signedIn = true,
  buildInFlight = false,
} = {}) {
  // No corpus at all is the first build: long, and worth watching.
  if (!hasCorpus) return { action: "manual", reason: "no-corpus" };
  if (!signedIn) return { action: "none", reason: "signed-out" };
  if (buildInFlight) return { action: "none", reason: "build-in-flight" };
  if (!online) return { action: "none", reason: "offline" };

  const synced = Date.parse(String(lastSyncAt || ""));
  if (!Number.isFinite(synced)) return { action: "manual", reason: "never-synced" };

  const ageHours = (now - synced) / HOUR;
  // A clock that moved backwards is not evidence of freshness, but it is also
  // no reason to hammer the API; treat it as current and wait for the next tick.
  if (ageHours < 0) return { action: "none", reason: "clock-skew" };
  if (ageHours < AUTO_SYNC_AFTER_HOURS) return { action: "none", reason: "fresh" };
  if (ageHours > MANUAL_SYNC_AFTER_DAYS * 24) return { action: "manual", reason: "stale" };

  // Back off after a failure so a broken token or a dead network does not turn
  // into a request on every page load.
  const attempted = Date.parse(String(lastAttemptAt || ""));
  if (Number.isFinite(attempted) && attempted <= now && (now - attempted) / 60_000 < RETRY_AFTER_MINUTES) {
    return { action: "none", reason: "backoff" };
  }
  return { action: "background", reason: "due" };
}

/**
 * What the stat bar says while a quiet sync runs.
 *
 * A background sync gets one word in a place the reader is already looking.
 * Anything larger would be the build card it exists to avoid.
 */
export function kbSyncStatusModel(state, { added = 0, removed = 0 } = {}) {
  if (state === "syncing") return { label: "checking…", busy: true };
  if (state === "failed") return { label: "update failed", busy: false };
  if (state === "done") {
    const parts = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`−${removed}`);
    return { label: parts.length ? `just now · ${parts.join(" · ")}` : "just now", busy: false };
  }
  return { label: "", busy: false };
}
