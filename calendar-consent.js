// calendar-consent.js — asking for Calendar access, and remembering the answer.
//
// Calendar is an INCREMENTAL grant, deliberately. The six Classroom scopes are
// requested at sign-in and the welcome card tells the student to tick all the
// boxes; bolting Calendar onto that list would force calendar access on
// everybody just to use the planner, and re-prompt every existing user. So this
// is a second, later authorization that only somebody who turns the switch on
// ever sees.
//
// Pure: no DOM, no network, no storage. The state shape is here because "which
// calendar belongs to which account" is exactly the kind of thing that is
// obvious until somebody switches accounts.

/**
 * The only Calendar scope this app ever asks for.
 *
 * "Make secondary Google calendars, and see, create, change, and delete events
 * on them." It cannot read, change or delete anything in a calendar the student
 * made — only the one we create. Do not add `calendar` or `calendar.events`
 * here; they are full access to every calendar the account owns, and the
 * consent screen would say so.
 */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

/**
 * Parameters for the incremental authorization.
 *
 * Only the Calendar scope is requested. `include_granted_scopes` (set by
 * buildAuthRedirectUrl) is what keeps the Classroom grant alive, so asking for
 * the Classroom scopes again here would be noise on the consent screen.
 *
 * No `select_account`: the student is already signed in and being asked to pick
 * their account again mid-settings reads as a bug. `login_hint` pins it instead.
 */
export function calendarAuthRequest({ loginHint = "" } = {}) {
  return {
    scope: CALENDAR_SCOPE,
    // Google shows the new scope on its own when include_granted_scopes is set,
    // but being explicit means a re-grant after a revoke also gets a screen
    // rather than silently failing.
    prompt: "consent",
    loginHint: String(loginHint || ""),
  };
}

/**
 * Did the grant actually include Calendar?
 *
 * Google may return fewer scopes than were asked for — a student can untick a
 * permission on the consent screen. Treating "the redirect came back" as
 * "we have access" is how an app ends up 403ing on every write with the switch
 * showing as on.
 */
export function hasCalendarScope(grantedScopes) {
  const list = typeof grantedScopes === "string"
    ? grantedScopes.split(/\s+/)
    : Array.isArray(grantedScopes) ? grantedScopes : [];
  return list.filter(Boolean).map(String).includes(CALENDAR_SCOPE);
}

/**
 * Per-account calendar state.
 *
 * Keyed by the Google account id (`sub` from userinfo), because the app lets
 * you switch accounts. A single global calendar id would, after a switch, point
 * at a calendar belonging to a different account: every write 404s, and the
 * recovery path then cheerfully creates a duplicate in the wrong place.
 */
export function calendarStateModel(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const accounts = input.accounts && typeof input.accounts === "object" && !Array.isArray(input.accounts)
    ? input.accounts
    : {};
  const out = {};
  for (const [id, raw] of Object.entries(accounts)) {
    const account = String(id || "").trim();
    if (!account || !raw || typeof raw !== "object") continue;
    out[account] = {
      enabled: raw.enabled === true,
      calendarId: typeof raw.calendarId === "string" ? raw.calendarId : "",
      lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : "",
    };
  }
  return { version: 1, accounts: out };
}

/** Read one account's state, defaulted. */
export function calendarStateFor(state, accountId) {
  const id = String(accountId || "").trim();
  const model = calendarStateModel(state);
  return model.accounts[id] || { enabled: false, calendarId: "", lastSyncAt: "" };
}

/** Merge a patch into one account's state, leaving every other account alone. */
export function setCalendarStateFor(state, accountId, patch = {}) {
  const id = String(accountId || "").trim();
  const model = calendarStateModel(state);
  if (!id) return model;
  model.accounts[id] = calendarStateModel({
    accounts: { [id]: { ...calendarStateFor(model, id), ...patch } },
  }).accounts[id];
  return model;
}

/**
 * What the Settings row should say.
 *
 * Four states, because "on" and "working" are not the same thing and a student
 * whose grant was revoked in their Google account needs to be told, not left
 * with a switch that looks fine and syncs nothing.
 */
export function calendarStatusModel({
  enabled = false,
  granted = false,
  calendarId = "",
  lastSyncAt = "",
  now = Date.now(),
} = {}) {
  if (!enabled) {
    return { state: "off", label: "Off. Your assignments are not being written to Google Calendar." };
  }
  if (!granted) {
    return {
      state: "needs-consent",
      label: "Waiting for permission — Google has not granted calendar access yet.",
      action: "reconnect",
    };
  }
  if (!calendarId) {
    return { state: "pending", label: "On. The calendar will be created the next time you open the site." };
  }
  const synced = Date.parse(String(lastSyncAt || ""));
  if (!Number.isFinite(synced)) {
    return { state: "ready", label: "On. Waiting for the first sync." };
  }
  const minutes = Math.floor((now - synced) / 60000);
  const ago = minutes < 2 ? "just now"
    : minutes < 60 ? `${minutes}m ago`
      : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
  return { state: "synced", label: `On. Last synced ${ago}.` };
}

/** The calendar we create, named so it is obvious where it came from. */
export const CALENDAR_SUMMARY = "Classroom assignments";
export const CALENDAR_DESCRIPTION =
  "Created by Classroom Analyzer. Assignments from Google Classroom, kept in step while you use the site. Safe to hide or delete — nothing else is affected.";

/** The body for calendars.insert. */
export function newCalendarBody({ timeZone = "" } = {}) {
  return {
    summary: CALENDAR_SUMMARY,
    description: CALENDAR_DESCRIPTION,
    ...(timeZone ? { timeZone: String(timeZone) } : {}),
  };
}

/** The calendarList.patch body for the on/off switch. Nothing is ever deleted here. */
export function calendarVisibilityPatch(visible) {
  return visible ? { hidden: false, selected: true } : { hidden: true, selected: false };
}

// ---------------------------------------------------------------------------
// Storage. Kept here rather than in kb.js so that app.js — which owns the
// assignments and therefore the sync — can read the switch without importing
// the Study module and dragging its whole subtree onto the critical path. The
// same reason route-transition.js exists.
// ---------------------------------------------------------------------------

export const CALENDAR_STATE_KEY = "cwa_kb_calendar";
const GRANTED_SCOPES_KEY = "cwa_granted_scopes";
const USER_PROFILE_KEY = "cwa_user_profile";

function store() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export function loadCalendarState() {
  try { return calendarStateModel(JSON.parse(store()?.getItem(CALENDAR_STATE_KEY) || "null")); }
  catch { return calendarStateModel(); }
}

export function saveCalendarState(state) {
  const next = calendarStateModel(state);
  try { store()?.setItem(CALENDAR_STATE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

/** The signed-in Google account id — what the per-account state is keyed by. */
export function currentAccountId() {
  try { return JSON.parse(store()?.getItem(USER_PROFILE_KEY) || "null")?.sub || ""; }
  catch { return ""; }
}

/** Scopes Google actually granted, as recorded by the auth redirect. */
export function grantedScopes() {
  try { return store()?.getItem(GRANTED_SCOPES_KEY) || ""; } catch { return ""; }
}

/** Is calendar sync switched on, granted, and for this account? */
export function calendarSyncReady(accountId = currentAccountId()) {
  if (!accountId || !hasCalendarScope(grantedScopes())) return false;
  return calendarStateFor(loadCalendarState(), accountId).enabled === true;
}
