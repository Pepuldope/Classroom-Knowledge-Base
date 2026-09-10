// report-freshness.js — when the Planner is showing yesterday's answer.
//
// Every date-relative thing on the Planner — "Do today / tomorrow", the day
// groups, "New since yesterday", the overdue count — is computed once, when
// the Classroom report loads, and then never again. In a browser tab that is
// invisible: a tab gets reloaded constantly. Installed to a home screen it is
// not: the window is suspended and resumed for days at a time, so the page
// that says "new since yesterday" can be answering a question asked on Monday.
//
// Two triggers, both cheap: the local date has changed since the list was
// built, or it has simply been a long time.

/** After this long in the background, re-ask Classroom rather than trust the list. */
export const REPORT_MAX_AGE_MS = 30 * 60 * 1000;

/** Local calendar day as a sortable YYYY-MM-DD, for comparing "which day is it". */
export function localDayKey(date = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Should the Planner reload the report now that it is visible again?
 *
 * `loadedAt` is when the current list was built (ms). A list built on a
 * different local day is stale however recently it was built — that is the
 * midnight rollover, and it is the one that makes "New since yesterday" lie.
 */
export function reportIsStale({ loadedAt = 0, now = Date.now(), maxAgeMs = REPORT_MAX_AGE_MS } = {}) {
  const built = Number(loadedAt);
  if (!Number.isFinite(built) || built <= 0) return false;
  const at = Number(now);
  if (!Number.isFinite(at)) return false;
  if (localDayKey(new Date(built)) !== localDayKey(new Date(at))) return true;
  return at - built >= Number(maxAgeMs);
}
