// session-position.js — where the reader was, so a reload puts them back.
//
// The site is one page: two routes and a four-tab Study view, all held in
// module variables. A reload therefore always landed on the Planner, on the
// Search tab, at the top of the page — and on a phone a reload is not a rare,
// deliberate act. An over-scroll at the top of a long result list IS a
// pull-to-refresh, so the reader lost their place by accident, repeatedly.
//
// Deliberately sessionStorage rather than localStorage. This record holds the
// search query, which is the one piece of the reader's own words the app would
// otherwise never write to disk. A per-tab record survives the reload it exists
// for and dies with the tab, instead of becoming a lasting history of what
// somebody searched for on a shared machine.

export const POSITION_KEY = "cwa_session_position";
export const POSITION_VIEWS = ["planner", "kb"];
export const POSITION_TABS = ["search", "browse", "curriculum", "manage"];
/** Longer than any real search; the cap keeps a pasted essay out of storage. */
export const MAX_POSITION_QUERY = 200;

/** Normalize a stored position; unknown routes and tabs never survive. */
export function sessionPositionModel(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const scroll = Number(input.scroll);
  return {
    view: POSITION_VIEWS.includes(input.view) ? input.view : "planner",
    tab: POSITION_TABS.includes(input.tab) ? input.tab : "search",
    query: typeof input.query === "string" ? input.query.slice(0, MAX_POSITION_QUERY) : "",
    scroll: Number.isFinite(scroll) && scroll > 0 ? Math.round(scroll) : 0,
  };
}

/** True when the stored position differs from where a cold load would land. */
export function positionNeedsRestore(value) {
  const p = sessionPositionModel(value);
  return p.view !== "planner" || p.tab !== "search" || p.query !== "" || p.scroll > 0;
}

/**
 * Whether the page is tall enough yet to honour a saved offset.
 *
 * Restoring scroll is a race against rendering: the Planner's list arrives
 * after a Classroom round-trip and the Study corpus after IndexedDB, so a
 * scroll issued on DOMContentLoaded lands on a page a few hundred pixels tall
 * and silently does nothing. The caller retries until this says yes.
 */
export function canRestoreScroll(scroll, { scrollHeight = 0, viewportHeight = 0 } = {}) {
  const target = Number(scroll);
  if (!Number.isFinite(target) || target <= 0) return false;
  return Number(scrollHeight) - Number(viewportHeight) >= target;
}

let cached = null;

function storage() {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Some privacy modes throw on the property access itself.
    return null;
  }
}

export function loadSessionPosition() {
  if (cached) return cached;
  try {
    cached = sessionPositionModel(JSON.parse(storage()?.getItem(POSITION_KEY) || "null"));
  } catch {
    cached = sessionPositionModel();
  }
  return cached;
}

/** Merge one or more fields into the stored position; returns the whole thing. */
export function saveSessionPosition(patch = {}) {
  cached = sessionPositionModel({ ...loadSessionPosition(), ...patch });
  try { storage()?.setItem(POSITION_KEY, JSON.stringify(cached)); } catch { /* private mode */ }
  return cached;
}
