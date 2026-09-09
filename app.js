// archive.js is shared plumbing now — markdown rendering and the IndexedDB
// primitives. Its bundle, search index and related-notes scorer duplicated the
// Knowledge Base's and went with the Archive view.
import {
  foldText,
  renderLightMarkdown,
  renderRichMarkdown,
  renderAssignmentDescription,
  loadLegacyArchiveBundle,
  removeLegacyArchiveBundle,
} from "./archive.js";
import { loadKbBundle, saveKbBundle, removeKbBundle } from "./kb-local.js";
import { migrateArchiveBundle } from "./kb-merge.js";
import { relatedNotes } from "./kb-client-search.js";
import { dueChipModel, groupPlannerItems } from "./planner-cards.js";
import { applyTheme, loadTheme } from "./theme.js";
import { plannerTutorContextModel, plannerTutorSourcesText, plannerTutorCopyStatusModel } from "./planner-tutor-context.js";
import { privateViewDecision, classroomAuthRecoveryModel } from "./auth-view.js";
import { kbLocalStatusModel } from "./kb-local-status.js";
import { kbViewTransitionFocusTargetModel, kbViewTransitionFocusAnnouncementModel, routeTransitionFocusPrivacyModel } from "./route-transition.js";
import { loadStoredAuthSession, storeAuthSession, clearAuthSession, sessionResumeModel } from "./auth-session.js";
import { buildAuthRedirectUrl, parseAuthRedirectResponse, randomState, AUTH_STATE_KEY } from "./auth-redirect.js";
import { isEnrichCandidate, isSubmittedState } from "./enrich-scope.js";
import { normalizeTaskKind } from "./task-kinds.js";
import { loadSessionPosition, saveSessionPosition, positionNeedsRestore, canRestoreScroll } from "./session-position.js";
import { sheetDragModel, viewportBottomInset } from "./sheet-drag.js";
import { assignmentPanelModel, groundingLineModel } from "./assignment-panel.js";
import { calendarSyncPlan, syncableAssignments } from "./calendar-sync.js";
import { createCalendarClient, googleCalendarRequest } from "./calendar-api.js";
import {
  calendarSyncReady, currentAccountId, loadCalendarState, saveCalendarState,
  setCalendarStateFor, calendarStateFor,
} from "./calendar-consent.js";

export { plannerTutorContextModel } from "./planner-tutor-context.js";

applyTheme(loadTheme());

const CLIENT_ID = "786778645862-cejadrqj2edabpdlk0emsvb1gc2hdijs.apps.googleusercontent.com";
const SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.topics.readonly",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");
const COURSES_HIDDEN_KEY = "cwa_hidden_courses";
const USER_HINT_KEY = "cwa_user_hint";

function loadHiddenCourses() {
  try { return new Set(JSON.parse(localStorage.getItem(COURSES_HIDDEN_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveHiddenCourses(set) {
  localStorage.setItem(COURSES_HIDDEN_KEY, JSON.stringify([...set]));
}
let hiddenCourseIds = loadHiddenCourses();
let allCourses = [];

const DISPLAY_PREFS_KEY = "cwa_display_prefs";
const defaultDisplayPrefs = { showSubmitted: false, showOverdueInDoNow: true, language: "en" };
function loadDisplayPrefs() {
  try { return { ...defaultDisplayPrefs, ...JSON.parse(localStorage.getItem(DISPLAY_PREFS_KEY) || "{}") }; }
  catch { return { ...defaultDisplayPrefs }; }
}
function saveDisplayPrefsLocal(p) {
  localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify(p));
}
let displayPrefs = loadDisplayPrefs();
let prefsStorageAvailable = true;
let prefsLoadedFromServer = false;

// Every request on the sign-in path must go through this. A bare fetch() has
// no timeout: if a request stalls rather than fails — which browsers with
// aggressive tracker/cookie blocking can do to Google endpoints — the whole
// awaited chain in onSignedIn hangs, #report is never unhidden, and even the
// try/finally guard there never runs, leaving a permanently blank page that
// only a reload clears.
const NET_TIMEOUT_MS = 20_000;

export function isTimeoutError(err) {
  return err?.name === "TimeoutError" || err?.name === "AbortError";
}

async function fetchWithTimeout(url, init = {}, ms = NET_TIMEOUT_MS) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadServerPrefs() {
  if (!prefsStorageAvailable || !accessToken) return null;
  try {
    const r = await fetchWithTimeout("/api/prefs", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 503) { prefsStorageAvailable = false; return null; }
    if (!r.ok) return null;
    const data = await r.json();
    return (data && data.prefs && typeof data.prefs === "object") ? data.prefs : {};
  } catch { return null; }
}

async function saveServerPrefs(prefs) {
  if (!prefsStorageAvailable || !accessToken) return;
  try {
    const r = await fetchWithTimeout("/api/prefs", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefs }),
    });
    if (r.status === 503) prefsStorageAvailable = false;
  } catch {}
}

async function syncPrefsFromServer() {
  const remote = await loadServerPrefs();
  if (!remote) return false;
  prefsLoadedFromServer = true;
  if (Array.isArray(remote.hiddenCourseIds)) {
    hiddenCourseIds = new Set(remote.hiddenCourseIds);
    saveHiddenCourses(hiddenCourseIds);
  }
  if (remote.display && typeof remote.display === "object") {
    displayPrefs = { ...defaultDisplayPrefs, ...remote.display };
    saveDisplayPrefsLocal(displayPrefs);
  }
  return true;
}

function pushPrefsToServer() {
  saveServerPrefs({ hiddenCourseIds: [...hiddenCourseIds], display: displayPrefs });
}

const SORT_KEY = "cwa_sort";
let currentSort = sessionStorage.getItem(SORT_KEY) || "default";
// The refresh token lives in an httpOnly cookie the page cannot read, so this
// flag is only a hint about whether it is worth asking the server for a
// refresh. It is not a credential and carries no identity — the cookie alone
// decides whose token gets minted.
const HAS_SERVER_SESSION_KEY = "cwa_has_server_session";

function hasServerSession() {
  try { return localStorage.getItem(HAS_SERVER_SESSION_KEY) === "1"; } catch { return false; }
}
function setServerSessionFlag(on) {
  try {
    if (on) localStorage.setItem(HAS_SERVER_SESSION_KEY, "1");
    else localStorage.removeItem(HAS_SERVER_SESSION_KEY);
  } catch {}
}

// Tell the server to forget this account's stored refresh token. Without this,
// oauth-refresh.js silently re-grants a token for the old account on every page
// load, so the user stays locked into the wrong (e.g. non-Classroom) account.
async function revokeServerToken() {
  setServerSessionFlag(false);
  try {
    await fetchWithTimeout("/api/oauth-revoke", { method: "POST" });
  } catch {}
}
// v13: v12 entries can carry taskKind "Question", which the prompt used to
// offer and the canonical list no longer contains. Bumping re-fetches them;
// the server answers from its own cache, so this costs no AI calls.
const ENRICH_KEY = "cwa_enrich_v13";
const DISMISSED_KEY = "cwa_dismissed";
const PINNED_KEY = "cwa_pinned";

function loadIdSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); }
  catch { return new Set(); }
}
function saveIdSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}
let dismissedIds = loadIdSet(DISMISSED_KEY);
let pinnedIds = loadIdSet(PINNED_KEY);
const WEEK_DAYS = 7;
const OVERDUE_GRACE_DAYS = 3;
const STALE_DAYS = 14;

let tokenClient = null;
let accessToken = null;
// Expose the access token on window so sibling modules (e.g. kb.js) can read it
// without reaching into app.js internals. A getter keeps it in sync with the
// module-local variable at every assignment site.
Object.defineProperty(window, "__cwaAccessToken", { get: () => accessToken, configurable: true });
let sessionEpoch = 0;
let activeAssignment = null;
let aiHistory = [];
let allAssignments = [];
let activeMaterials = [];
let lazyEnrichTriggered = false;
let currentView = "planner"; // "planner" | "kb" (the Study page)
const chatHistories = new Map();
let chatStorageAvailable = true;

async function loadChatHistory(assignmentId) {
  if (!chatStorageAvailable || !accessToken) return null;
  try {
    const r = await fetch(`/api/chat?assignmentId=${encodeURIComponent(assignmentId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 503) { chatStorageAvailable = false; return null; }
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data.messages) ? data.messages : [];
  } catch { return null; }
}

async function saveChatHistory(assignmentId, messages) {
  if (!chatStorageAvailable || !accessToken) return;
  try {
    const r = await fetch(`/api/chat?assignmentId=${encodeURIComponent(assignmentId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (r.status === 503) chatStorageAvailable = false;
  } catch {}
}

async function pruneChats(keepIds) {
  if (!chatStorageAvailable || !accessToken) return;
  try {
    const r = await fetch("/api/chat-prune", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keepIds }),
    });
    if (r.status === 503) chatStorageAvailable = false;
  } catch {}
}

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", !!isError);
}

async function loadStoredToken() {
  return loadStoredAuthSession();
}

let refreshTimer = null;
function scheduleSilentRefresh(expiresInSec) {
  if (refreshTimer) clearTimeout(refreshTimer);
  const ms = Math.max(15_000, (expiresInSec - 90) * 1000);
  refreshTimer = setTimeout(async () => {
    const cfg = await getOauthConfig();
    const refreshed = (cfg.hasRefreshTokens && hasServerSession()) ? await serverRefreshAccessToken() : null;
    if (!refreshed) silentRefresh();
  }, ms);
}

function storeToken(token, expiresInSec) {
  storeAuthSession(token, expiresInSec).catch(() => {});
  scheduleSilentRefresh(expiresInSec);
}

function clearToken() {
  clearAuthSession().catch(() => {});
  accessToken = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

function loadUserHint() {
  try { return localStorage.getItem(USER_HINT_KEY) || ""; } catch { return ""; }
}
function storeUserHint(hint) {
  if (!hint) return;
  try { localStorage.setItem(USER_HINT_KEY, hint); } catch {}
}

const GOOGLE_AUTHUSER_HOSTS = /(?:^|\.)google\.com$/i;
function withAuthUser(url) {
  if (!url) return url;
  const email = loadUserHint();
  if (!email) return url;
  try {
    // Base only matters for a relative href; use this deployment's own origin
    // rather than the predecessor project's domain.
    const u = new URL(url, location.origin);
    if (!GOOGLE_AUTHUSER_HOSTS.test(u.hostname)) return url;
    if (!u.searchParams.has("authuser")) u.searchParams.set("authuser", email);
    return u.toString();
  } catch { return url; }
}

let codeClient = null;
let serverRefreshAvailable = true;

/**
 * Get a usable access token, trying every recovery route in one fixed order.
 *
 * This exists because the order was NOT fixed. Boot tried the server refresh
 * (the httpOnly refresh cookie, which survives the browser being closed) before
 * falling back to GIS silent auth. gFetch's 401 handler tried ONLY GIS silent
 * auth — and GIS silent auth is exactly what fails on a phone, where
 * third-party cookie restrictions make a promptless token request unreliable.
 *
 * So on mobile: come back after the token expired, the first Classroom call
 * 401s, the GIS-only recovery fails, the session is cleared, and you are asked
 * to sign in. Reload the page and boot's server-refresh path signs you straight
 * back in "as if nothing happened".
 *
 * `useStored` is false when the caller already knows the stored token is the
 * one that just failed.
 */
async function recoverAccessToken({ useStored = true } = {}) {
  if (useStored) {
    const stored = await loadStoredToken();
    if (stored?.token) {
      accessToken = stored.token;
      scheduleSilentRefresh(Math.max(60, Math.round((stored.expiresAt - Date.now()) / 1000)));
      return accessToken;
    }
  }
  const cfg = await getOauthConfig().catch(() => ({}));
  if (cfg?.hasRefreshTokens && hasServerSession()) {
    const token = await serverRefreshAccessToken();
    if (token) return token;
  }
  if (loadUserHint()) {
    const ok = await silentRefresh();
    if (ok && accessToken) return accessToken;
  }
  return null;
}

async function serverRefreshAccessToken() {
  if (!serverRefreshAvailable) return null;
  if (!hasServerSession()) return null;
  try {
    // No body: the endpoint reads the httpOnly refresh cookie this request
    // carries. Nothing here names an account.
    const r = await fetchWithTimeout("/api/oauth-refresh", { method: "POST" });
    if (r.status === 500 || r.status === 503) { serverRefreshAvailable = false; return null; }
    if (r.status === 401 || r.status === 404) {
      // Cookie missing, expired or revoked — stop asking.
      setServerSessionFlag(false);
      return null;
    }
    if (!r.ok) return null;
    const data = await r.json();
    if (data.access_token) {
      accessToken = data.access_token;
      storeToken(accessToken, Number(data.expires_in) || 3600);
      return accessToken;
    }
    return null;
  } catch { return null; }
}

// Background token refresh. This MUST run on its own token client
// (silentTokenClient, built in initGis) and never by swapping the interactive
// tokenClient's callback in place. The silent flow (prompt: "") depends on the
// accounts.google.com session in a third-party context, so browsers that block
// third-party cookies by default — Arc, notably — fail it, and GIS reports that
// class of failure through error_callback only. With a swapped callback and no
// error_callback that meant the interactive callback stayed hijacked for the
// life of the page: a subsequent sign-in stored its token but never called
// onSignedIn(), so the app sat blank until a manual reload restored it from
// IndexedDB.
const SILENT_REFRESH_TIMEOUT_MS = 10_000;
// Longer than NET_TIMEOUT_MS so a stalled request reports its own, more
// specific error before this generic fallback fires.
const SIGNIN_WATCHDOG_MS = 25_000;
let silentTokenClient = null;
let kbTokenClient = null;
let silentRefreshInFlight = null;
let silentRefreshResolve = null;
let silentRefreshTimer = null;

function settleSilentRefresh(ok) {
  if (!silentRefreshResolve) return;
  const resolve = silentRefreshResolve;
  silentRefreshResolve = null;
  silentRefreshInFlight = null;
  if (silentRefreshTimer) { clearTimeout(silentRefreshTimer); silentRefreshTimer = null; }
  resolve(ok);
}

function onSilentTokenResponse(resp) {
  if (resp && resp.access_token) {
    accessToken = resp.access_token;
    storeToken(accessToken, Number(resp.expires_in) || 3600);
    settleSilentRefresh(true);
  } else {
    settleSilentRefresh(false);
  }
}

function silentRefresh() {
  if (!silentTokenClient) return Promise.resolve(false);
  if (silentRefreshInFlight) return silentRefreshInFlight;
  silentRefreshInFlight = new Promise((resolve) => {
    silentRefreshResolve = resolve;
    // Always settle. A silent request that never calls back at all would
    // otherwise leave every `await silentRefresh()` — including gFetch's 401
    // retry, which loadReport sits behind — pending forever.
    silentRefreshTimer = setTimeout(() => settleSilentRefresh(false), SILENT_REFRESH_TIMEOUT_MS);
    try {
      silentTokenClient.requestAccessToken({ prompt: "", hint: loadUserHint() || undefined });
    } catch { settleSilentRefresh(false); }
  });
  return silentRefreshInFlight;
}

function loadEnrichCache() {
  let cache;
  try { cache = JSON.parse(localStorage.getItem(ENRICH_KEY) || "{}"); } catch { return {}; }
  if (!cache || typeof cache !== "object") return {};
  // Earlier builds stored the server's per-assignment {id, error} object as
  // though it were a result. A stored failure is indistinguishable from a
  // real enrichment to applyCachedEnrichments, so the assignment was never
  // re-requested: no estimate, no retry, nothing logged, permanently. Writing
  // them stopped, but the ones already on disk have to be dropped or they
  // pin those assignments forever.
  let dropped = 0;
  for (const [k, v] of Object.entries(cache)) {
    if (!v || typeof v !== "object" || v.error) { delete cache[k]; dropped += 1; }
  }
  // Entries written when the vocabulary was larger still carry retired kinds
  // ("Question", "Problem set", "Exam"). Map them on read instead of bumping
  // ENRICH_KEY again — a bump discards good results and re-requests every
  // assignment, which is exactly what the shared quota cannot afford.
  let relabelled = 0;
  for (const v of Object.values(cache)) {
    if (!v.taskKind) continue;
    const canonical = normalizeTaskKind(v.taskKind);
    if (canonical !== v.taskKind) { v.taskKind = canonical; relabelled += 1; }
  }
  if (dropped || relabelled) {
    try { localStorage.setItem(ENRICH_KEY, JSON.stringify(cache)); } catch {}
  }
  if (dropped) console.info(`[enrich] dropped ${dropped} cached failure(s); they will be retried`);
  if (relabelled) console.info(`[enrich] relabelled ${relabelled} cached kind(s) onto the current list`);
  return cache;
}
function saveEnrichCache(cache) {
  localStorage.setItem(ENRICH_KEY, JSON.stringify(cache));
}
function contentHash(a) {
  const s = `${a.title || ""}|${(a.description || "").slice(0, 400)}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}
function enrichCacheKey(a) {
  return `${a.id}:${contentHash(a)}`;
}

const OAUTH_CONFIG_CACHE_KEY = "cwa_oauth_config";
let oauthConfigPromise = null;
function getOauthConfig() {
  if (oauthConfigPromise) return oauthConfigPromise;
  try {
    const cached = sessionStorage.getItem(OAUTH_CONFIG_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      oauthConfigPromise = Promise.resolve(parsed);
      return oauthConfigPromise;
    }
  } catch {}
  // Only a real answer is worth remembering. The fallback below is a guess
  // made because the server could not be reached, and caching a guess is what
  // makes a momentary blip permanent: hasRefreshTokens:false sends sign-in
  // down the implicit flow, which issues no refresh token, so consent — and
  // on an unverified client its warning screen — is demanded on every visit
  // for the life of the tab. Drop the memoised promise too, so the next
  // caller retries instead of inheriting the failure.
  oauthConfigPromise = fetchWithTimeout("/api/oauth-config")
    .then((r) => {
      if (!r.ok) throw new Error(`oauth-config ${r.status}`);
      return r.json();
    })
    .then((cfg) => {
      try { sessionStorage.setItem(OAUTH_CONFIG_CACHE_KEY, JSON.stringify(cfg)); } catch {}
      return cfg;
    })
    .catch(() => {
      oauthConfigPromise = null;
      return { hasRefreshTokens: false };
    });
  return oauthConfigPromise;
}

async function initGis() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) {
        setStatus(`Auth failed: ${resp.error}`, true);
        return;
      }
      accessToken = resp.access_token;
      storeToken(accessToken, Number(resp.expires_in) || 3600);
      onSignedIn();
    },
    // Non-OAuth failures (popup blocked, popup closed, unknown) arrive here and
    // never through `callback`. Without this the UI gave no feedback at all.
    error_callback: (err) => {
      const type = err?.type || "unknown";
      if (type === "popup_closed") { setStatus(""); return; }
      setStatus(`Auth failed: ${type}`, true);
    },
  });

  // Separate client for background refresh — see silentRefresh() above.
  silentTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: onSilentTokenResponse,
    error_callback: () => settleSilentRefresh(false),
  });

  // Third client, handed to kb.js. That module assigns its own .callback
  // before each request, so it must never be given a client anyone else
  // depends on — clobbering a shared callback is the bug fixed in d4bacd5.
  kbTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: () => {},
  });

  const cfg = await getOauthConfig();
  if (cfg.hasRefreshTokens) {
    codeClient = google.accounts.oauth2.initCodeClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      ux_mode: "popup",
      // Always show the account chooser so the user can pick their SCHOOL
      // Google account (not a cached/family/main account). Without this, Google
      // silently reuses the last-approved account and the user gets a 400 when
      // that account isn't in a Classroom domain (see handleClassroomAuthError).
      prompt: "select_account",
      error_callback: (err) => {
          const type = err?.type || "unknown";
        if (type === "popup_closed") { setStatus(""); return; }
        setStatus(`Sign-in failed: ${type}`, true);
      },
      callback: async (resp) => {
          if (!resp || !resp.code) {
          setStatus(`Auth failed: ${resp?.error || "no code"}`, true);
          return;
        }
        setStatus("Signing in…");
        try {
          const r = await fetchWithTimeout("/api/oauth-exchange", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: resp.code, redirectUri: "postmessage" }),
          });
          if (!r.ok) {
            const errData = await r.json().catch(() => ({}));
            setStatus(`Sign-in failed: ${errData.error || r.status}`, true);
            return;
          }
          const data = await r.json();
          accessToken = data.access_token;
          storeToken(accessToken, Number(data.expires_in) || 3600);
          setServerSessionFlag(!!data.has_refresh);
          if (data.email) storeUserHint(data.email);
          onSignedIn();
        } catch (e) {
          setStatus(`Sign-in failed: ${e.message}`, true);
        }
      },
    });
  }

  // Restoring a session does not need any of the above; see restoreSession().
}

let restoreSessionStarted = false;

/**
 * Sign the user back in from what this browser already has.
 *
 * Deliberately independent of the Google Identity Services script. This ran
 * inside initGis(), which only runs once `window.google.accounts.oauth2`
 * exists — and waitForGis() polls for that forever. So if accounts.google.com
 * was slow, blocked or unreachable (a phone on a patchy connection returning to
 * the site is the everyday case), the app sat on the sign-in screen with a
 * perfectly good token in IndexedDB and a refresh cookie on the server, and the
 * sign-in button did nothing either because its token client was never built.
 * Reloading once the script was cached then "signed you back in as if nothing
 * happened".
 *
 * Neither the stored token nor the server refresh needs Google's script. Only
 * the last-resort GIS silent refresh does, and that is left to run if and when
 * the script turns up.
 */
async function restoreSession() {
  if (restoreSessionStarted) return;
  restoreSessionStarted = true;

  // consumeAuthRedirect() may still be redeeming a code. Wait for it, then
  // bail if it signed us in: storeToken() already armed the refresh timer, and
  // a second onSignedIn() here would bump sessionEpoch and strand the first
  // one's render.
  await authRedirectSettled.catch(() => false);
  if (accessToken) return;

  const stored = await loadStoredToken();
  if (stored && stored.token) {
    accessToken = stored.token;
    const remaining = Math.max(60, Math.round((stored.expiresAt - Date.now()) / 1000));
    scheduleSilentRefresh(remaining);
    onSignedIn();
    return;
  }

  const cfg = await getOauthConfig().catch(() => ({ hasRefreshTokens: false }));
  // Server-side refresh first: it works after a browser restart, and needs no
  // Google script. GIS silent auth is the fallback, not the first resort.
  if (cfg.hasRefreshTokens && hasServerSession()) {
    const token = await serverRefreshAccessToken();
    if (token) { onSignedIn(); return; }
  }
  if (loadUserHint()) {
    const ok = await silentRefresh();
    if (ok) onSignedIn();
  }
}

// --- Redirect sign-in (no popup) -------------------------------------------

function authRedirectUri() {
  // Must match an Authorized redirect URI on the OAuth client exactly —
  // Google compares the whole string, and a trailing slash is part of it.
  // The origin with no slash is what the client has registered for
  // classroom-knowledge.vercel.app; sending the slashed form against it is
  // an Error 400: redirect_uri_mismatch, not a scope or consent problem.
  // Both the authorization request and the token exchange read this, so the
  // two always agree.
  return location.origin;
}

/** Remember what Google granted, so the Calendar switch can tell truth from hope. */
function storeGrantedScopes(scope) {
  const value = String(scope || "").trim();
  if (!value) return;
  try {
    // A union: an incremental grant returns the new scope alongside the old
    // ones, but a flow that returns only the new one must not erase the rest.
    const merged = new Set([...(localStorage.getItem("cwa_granted_scopes") || "").split(/\s+/), ...value.split(/\s+/)]);
    merged.delete("");
    localStorage.setItem("cwa_granted_scopes", [...merged].join(" "));
  } catch { /* private mode */ }
}

async function startRedirectSignIn(prompt = "select_account", { scope = SCOPES, loginHint = null } = {}) {
  let state = "";
  try {
    state = randomState();
    sessionStorage.setItem(AUTH_STATE_KEY, state);
  } catch {
    setStatus("Sign-in needs site storage enabled for this site.", true);
    return;
  }
  // Prefer the code flow when the server can redeem it — that is the only way
  // to get a refresh token, and so the only way a session outlives the access
  // token. Falls back to implicit when unconfigured, so sign-in still works.
  const cfg = await getOauthConfig().catch(() => ({ hasRefreshTokens: false }));
  const responseType = cfg.hasRefreshTokens ? "code" : "token";
  // Only ask Google to re-run consent when this browser has no refresh token
  // yet. Consent is the one screen that mints one — and, while the OAuth
  // client is unverified, the one screen that carries the "Google hasn't
  // verified this app" warning. Asking on every sign-in showed that warning
  // every time while re-minting a token we already had.
  const forceConsent = !hasServerSession();
  // Google rejects the request with redirect_uri_mismatch unless this exact
  // string — trailing slash included — is listed under Authorized redirect
  // URIs (NOT Authorized JavaScript origins) on the OAuth client. Every
  // origin the app is served from needs its own entry, preview deploys
  // included, so log it rather than making someone guess.
  console.info("[auth] redirect_uri =", authRedirectUri());
  setStatus("Redirecting to Google…");
  location.assign(buildAuthRedirectUrl({
    clientId: CLIENT_ID,
    scope,
    redirectUri: authRedirectUri(),
    state,
    responseType,
    prompt,
    forceConsent,
    // Only hint on a plain re-auth; never when the user asked to switch.
    loginHint: loginHint ?? (prompt === "select_account" ? "" : loadUserHint()),
  }));
}

/**
 * Handle a return from Google. Runs before initGis so the token is in place
 * by the time the stored-session logic there looks for one.
 */
async function consumeAuthRedirect() {
  // Captured before the exchange overwrites either one: together they say
  // whether a refresh token that came back empty is fine (same account, the
  // stored one still applies) or stale (a different account signed in).
  const hadServerSession = hasServerSession();
  const priorHint = loadUserHint();
  let expected = null;
  try { expected = sessionStorage.getItem(AUTH_STATE_KEY); } catch {}
  const result = parseAuthRedirectResponse(location.search, location.hash, expected);
  if (!result) return false;
  try { sessionStorage.removeItem(AUTH_STATE_KEY); } catch {}
  // Strip the code/token from the address bar before anything else reads it,
  // and before it can end up in history or a shared URL.
  try { history.replaceState(null, "", location.pathname); } catch {}

  if (result.error) {
    const msg = result.error === "access_denied"
      ? "Sign-in was cancelled."
      : result.error === "state_mismatch"
        ? "Sign-in couldn't be verified. Please try again."
        : `Sign-in failed: ${result.error}`;
    setStatus(msg, true);
    return false;
  }

  // Implicit flow: the token is already here.
  if (result.token) {
    accessToken = result.token;
    storeGrantedScopes(result.scope);
    storeToken(accessToken, result.expiresIn);
    setServerSessionFlag(false);
    onSignedIn();
    return true;
  }

  // Code flow: the server redeems the code and sets the refresh cookie.
  setStatus("Signing in…");
  try {
    const r = await fetchWithTimeout("/api/oauth-exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: result.code, redirectUri: authRedirectUri() }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      setStatus(`Sign-in failed: ${data.error || r.status}`, true);
      return false;
    }
    const data = await r.json();
    accessToken = data.access_token;
    storeGrantedScopes(result.scope || data.scope);
    storeToken(accessToken, Number(data.expires_in) || 3600);
    if (data.email) storeUserHint(data.email);
    // A sign-in that skipped consent gets no refresh token back, because the
    // server had no new one to store — the cookie from the earlier consent is
    // still the live credential. That only holds for the same account though:
    // signing in as someone else leaves the stored token pointing at the old
    // one, so drop the flag and let the next sign-in ask for consent again.
    const sameAccount = !!data.email && data.email === priorHint;
    setServerSessionFlag(!!data.has_refresh || (hadServerSession && sameAccount));
    onSignedIn();
    return true;
  } catch (e) {
    setStatus(isTimeoutError(e) ? "Sign-in timed out. Please try again." : `Sign-in failed: ${e.message}`, true);
    return false;
  }
}

// Kick off before initGis so a token is in place by the time it looks.
const authRedirectSettled = consumeAuthRedirect();

// Restore first, and without waiting for anything of Google's.
void restoreSession();

const GIS_WAIT_TIMEOUT_MS = 20_000;
let gisWaitStarted = 0;

function waitForGis() {
  if (window.google?.accounts?.oauth2) {
    initGis();
    // Expose the token client so the Knowledge-Base module can request a
    // Classroom-scoped token for building the user's local knowledge base.
    window.__cwaTokenClient = kbTokenClient;
    // kb.js is NOT loaded here. It is 141KB and pulls the search index, the
    // Classroom builder, the curriculum matrix and the local store behind it —
    // none of which the Planner needs. showKbView() wires the KB's listeners
    // itself, idempotently, so the only thing this eager import bought was
    // putting the whole Study subsystem on the critical path of every load.
    return;
  }
  if (!gisWaitStarted) gisWaitStarted = Date.now();
  if (Date.now() - gisWaitStarted > GIS_WAIT_TIMEOUT_MS) {
    // Stop polling forever and say so. A restored session keeps working — it
    // never needed this script — but interactive sign-in cannot happen without
    // it, and silence was indistinguishable from "the button is broken".
    if (!accessToken) {
      setStatus("Google sign-in could not load. Check your connection and reload.", true);
    }
    return;
  }
  setTimeout(waitForGis, 100);
}
waitForGis();

// ---------------------------------------------------------------------------
// Study — one corpus of everything the student has been taught.
//
// The Archive view used to live here: a second page with its own IndexedDB
// bundle, its own search implementation and its own browse tree, all
// duplicating the Knowledge Base. It is gone. What was worth keeping moved into
// the Study page (kb.js, kb-curriculum.js); what remains below is the one-time
// migration that folds a legacy Archive bundle into the single corpus, and the
// Planner's related-notes strip — the only reader of the notes outside Study.
// ---------------------------------------------------------------------------

let libraryBundle = null;    // the merged corpus, for the Planner strip
let activeLibraryNotes = []; // related notes shown beside the open AI panel

/**
 * Fold a pre-merge Archive bundle into the KB corpus, once.
 *
 * The legacy `bundle` / `meta` records are deleted only after the merged save
 * resolves, so an interrupted migration leaves the original intact and simply
 * runs again on the next load.
 */
async function migrateLegacyArchive() {
  const legacy = await loadLegacyArchiveBundle().catch(() => null);
  if (!legacy || !Array.isArray(legacy.notes) || legacy.notes.length === 0) return;
  const current = await loadKbBundle().catch(() => null);
  const merged = migrateArchiveBundle(legacy, current);
  if (!merged) return;
  await saveKbBundle(merged);
  await removeLegacyArchiveBundle();
  console.info(`[study] merged ${legacy.notes.length} archived notes into your knowledge base`);
}

async function refreshLibraryBundle() {
  libraryBundle = await loadKbBundle().catch(() => null);
}

migrateLegacyArchive()
  .catch((e) => console.warn("[study] archive migration skipped:", e?.message || e))
  .then(refreshLibraryBundle)
  .then(updateViewToggle)
  .catch(() => {});

function updateViewToggle() {
  const toggle = $("viewToggle");
  if (!toggle) return;
  // Visible while signed out so a student can see what is on offer; the Study
  // route itself is gated in setView().
  toggle.hidden = false;
}

function setView(view) {
  const access = privateViewDecision(view, accessToken);
  if (!access.allowed) {
    currentView = access.fallback;
    setStatus(access.message, true);
    view = access.fallback;
  }
  currentView = view;
  saveSessionPosition({ view });
  const plannerView = $("plannerView");
  const kbView = $("kbView");
  if (plannerView) plannerView.hidden = view === "kb";
  if (kbView) kbView.hidden = view !== "kb";
  if (view !== "kb") {
    const kbNoteModal = $("kbNoteModal");
    const kbTutorModal = $("kbTutorModal");
    const modalWasOpen = Boolean((kbNoteModal && !kbNoteModal.hidden) || (kbTutorModal && !kbTutorModal.hidden));
    const closeKbModals = () => {
      if (kbNoteModal) kbNoteModal.hidden = true;
      if (kbTutorModal) kbTutorModal.hidden = true;
    };
    closeKbModals();
    // A lazy KB module may finish wiring after the route click; close again
    // after that asynchronous import so a stale modal cannot survive the transition.
    setTimeout(closeKbModals, 100);
    const focusTarget = kbViewTransitionFocusTargetModel({ from: "kb", to: view, modalWasOpen });
    if (focusTarget) {
      const targetButton = document.querySelector(`.view-toggle-btn[data-view="${focusTarget}"]`);
      document.querySelectorAll(".view-toggle-btn").forEach((button) => button.classList.remove("view-toggle-focus-restored"));
      targetButton?.focus();
      targetButton?.classList.add("view-toggle-focus-restored");
      const focusStatus = document.getElementById("routeTransitionFocusStatus");
      const announcement = kbViewTransitionFocusAnnouncementModel(focusTarget);
      if (focusStatus && announcement) {
        const safeMarker = routeTransitionFocusPrivacyModel(announcement.text);
        focusStatus.setAttribute("role", announcement.role);
        focusStatus.setAttribute("aria-live", announcement.live);
        focusStatus.setAttribute("aria-atomic", announcement.atomic);
        focusStatus.textContent = safeMarker.text;
      }
    }
  }
  document.querySelectorAll(".view-toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
    btn.setAttribute("aria-selected", btn.dataset.view === view ? "true" : "false");
  });
  if (view === "kb") { import("./kb.js").then((m) => m.showKbView()).catch(() => {}); }
}

/**
 * The Planner's "From your notes" chips, and the notes the tutor is grounded in.
 *
 * Scored with the KB's `relatedNotes` (kb-client-search.js) rather than
 * archive.js's parallel implementation: the two ranked the same notes
 * differently, and this one drops stopwords so generic Classroom phrasing
 * cannot fake a match, and caches tokens per note.
 */
function renderLibraryStrip(a) {
  const strip = $("aiArchiveStrip");
  if (!strip) return;
  activeLibraryNotes = [];
  const notes = Array.isArray(libraryBundle?.notes) ? libraryBundle.notes : [];
  const clear = () => { strip.hidden = true; strip.innerHTML = ""; };
  if (notes.length === 0) return clear();

  const related = relatedNotes(notes, {
    t: a.title || "",
    course: a.courseName || "",
    topic: "",
    x: (a.description || "").slice(0, 300),
  }, { limit: 5 });
  if (related.length === 0) return clear();

  activeLibraryNotes = related;
  strip.innerHTML = "";
  const label = document.createElement("div");
  label.className = "archive-strip-label";
  label.textContent = "From your notes";
  strip.appendChild(label);

  const row = document.createElement("div");
  row.className = "archive-strip-row";
  for (const note of related) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "archive-strip-item";

    const title = document.createElement("div");
    title.className = "archive-strip-title";
    title.textContent = note.t || "(untitled)";

    const meta = document.createElement("div");
    meta.className = "archive-strip-meta";
    meta.textContent = [note.course, note.y, note.topic].filter(Boolean).join(" · ");

    chip.append(title, meta);
    // Open it where notes actually live now, rather than in a second modal.
    chip.addEventListener("click", () => openInStudy(note.t || ""));
    row.appendChild(chip);
  }
  strip.appendChild(row);
  strip.hidden = false;
}

// ---------------------------------------------------------------------------
// Where you were.
//
// Everything about which page you are on lives in module variables, so every
// reload landed on the Planner, at the top. On a phone that is not a rare,
// deliberate act: an over-scroll at the top of a long list IS pull-to-refresh,
// and the reader was thrown back to the Planner for it several times a session.
//
// The browser's own scroll restoration cannot help here — the Planner's list
// arrives after a Classroom round-trip and the Study corpus after IndexedDB, so
// at the moment the browser tries, the page is a header and a spinner. We turn
// it off and do it ourselves, once there is a page to scroll.
// ---------------------------------------------------------------------------
try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch { /* not supported */ }

let positionRestored = false;
let restoringPosition = false;
let scrollWriteQueued = false;

window.addEventListener("scroll", () => {
  // A flick down a long list fires hundreds of these; one write per frame.
  if (scrollWriteQueued) return;
  scrollWriteQueued = true;
  requestAnimationFrame(() => {
    scrollWriteQueued = false;
    // Our own scrollTo is not the reader choosing a place.
    if (restoringPosition) return;
    saveSessionPosition({ scroll: window.scrollY });
  });
}, { passive: true });

/**
 * Put the reader back where they were, once the page is tall enough to hold it.
 *
 * Called after the signed-in view has hydrated. Study restores its own tab and
 * query in `refreshKb`; this owns the route and the scroll offset.
 */
function restoreSessionPosition(epoch) {
  if (positionRestored) return;
  positionRestored = true;
  const position = loadSessionPosition();
  if (!positionNeedsRestore(position)) return;
  if (position.view !== currentView) setView(position.view);
  if (position.scroll <= 0) return;

  restoringPosition = true;
  const deadline = Date.now() + 4000;
  const stop = () => {
    restoringPosition = false;
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchstart", stop);
    window.removeEventListener("keydown", stop);
  };
  // The reader gets the page back the instant they reach for it. Waiting out
  // the deadline while someone is already scrolling would yank it from under
  // them, which is the bug this exists to fix, in the other direction.
  window.addEventListener("wheel", stop, { passive: true, once: true });
  window.addEventListener("touchstart", stop, { passive: true, once: true });
  window.addEventListener("keydown", stop, { once: true });

  const attempt = () => {
    if (!restoringPosition || epoch !== sessionEpoch) return stop();
    const ready = canRestoreScroll(position.scroll, {
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    });
    if (ready) {
      window.scrollTo(0, position.scroll);
      // One more frame so our own scroll event is swallowed by the guard.
      return requestAnimationFrame(stop);
    }
    if (Date.now() > deadline) return stop();
    requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** Route to Study and search for a topic. */
function openInStudy(topic) {
  setView("kb");
  import("./kb.js").then((m) => m.kbSearchTopic(topic)).catch(() => {});
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".view-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
});


document.addEventListener("DOMContentLoaded", () => {
  const w = $("restWrap");
  if (w) w.addEventListener("toggle", maybeLazyEnrichRest);

  $("settingsBtn").addEventListener("click", () => { closeMenu(); openSettingsModal(); });
  $("settingsClose").addEventListener("click", () => { $("settingsModal").hidden = true; });
  $("settingsSaveBtn").addEventListener("click", saveSettingsAndReload);
  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchSettingsTab(tab.dataset.tab));
  });

  $("feedbackBtn").addEventListener("click", () => { closeMenu(); openFeedbackModal(); });
  $("feedbackClose").addEventListener("click", () => { $("feedbackModal").hidden = true; });
  $("feedbackSendBtn").addEventListener("click", sendFeedback);

  $("sbSettings").addEventListener("click", openSettingsModal);
  $("sbFeedback").addEventListener("click", openFeedbackModal);
  $("sbLogout").addEventListener("click", () => $("logoutBtn").click());

  const menuBtn = $("menuBtn");
  const menuPop = $("menuPopover");
  if (menuBtn && menuPop) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menuPop.hidden) openMenu(); else closeMenu();
    });
    document.addEventListener("click", (e) => {
      if (!menuPop.hidden && !menuPop.contains(e.target) && e.target !== menuBtn) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });
  }
});

function openMenu() {
  const pop = $("menuPopover");
  const btn = $("menuBtn");
  if (!pop || !btn) return;
  pop.hidden = false;
  btn.setAttribute("aria-expanded", "true");
}
function closeMenu() {
  const pop = $("menuPopover");
  const btn = $("menuBtn");
  if (!pop || !btn) return;
  pop.hidden = true;
  btn.setAttribute("aria-expanded", "false");
}

async function configureKbSettingsUi() {
  const kb = await import("./kb.js");
  const s = kb.loadKbSettings();
  const set = (id, value, prop = "value") => { const el = $(id); if (el) el[prop] = value; };
  set("kbPrefTutorEnabled", s.tutorEnabled, "checked");
  set("kbPrefTutorEffort", s.tutorEffort);
  set("kbPrefScope", s.defaultScope);
  set("kbPrefSort", s.defaultSort);
  set("kbPrefRelatedCount", s.relatedCount);
  set("kbPrefRelatedCountValue", s.relatedCount, "textContent");
  set("kbPrefDensity", s.density);
  set("kbPrefCopyFormat", s.copyFormat);
  set("kbPrefSpeechRate", s.speechRate);
  set("kbPrefSpeechRateValue", `${s.speechRate}×`, "textContent");
  set("kbPrefAutoBuild", s.autoBuild, "checked");
  const pinnedList = $("kbPinnedCoursesList");
  if (pinnedList) {
    const bundle = await loadKbBundle().catch(() => null);
    const courses = [...new Set((bundle?.notes || []).map((note) => String(note?.course || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const pinned = new Set(kb.loadKbPinnedCourses());
    pinnedList.innerHTML = "";
    if (!courses.length) {
      pinnedList.innerHTML = '<span class="settings-hint">Build your local knowledge base to choose courses.</span>';
    } else {
      for (const course of courses) {
        const label = document.createElement("label");
        label.className = "settings-check-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = course;
        checkbox.checked = pinned.has(course);
        const text = document.createElement("span");
        text.textContent = course;
        label.append(checkbox, text);
        pinnedList.appendChild(label);
      }
    }
  }
  const accountStatus = $("kbAccountStatus");
  const cachedProfile = loadCachedProfile();
  if (accountStatus) accountStatus.textContent = cachedProfile?.email
    ? `Signed in as ${cachedProfile.email}`
    : (cachedProfile?.name ? `Signed in as ${cachedProfile.name}` : "Not signed in");
  const switchAccountButton = $("kbSwitchAccount");
  const signOutButton = $("kbSignOut");
  if (switchAccountButton) switchAccountButton.onclick = () => $("switchBtn")?.click();
  if (signOutButton) signOutButton.onclick = () => $("logoutBtn")?.click();
  set("prefTheme", loadTheme());
  const relatedCount = $("kbPrefRelatedCount");
  if (relatedCount) relatedCount.oninput = (e) => { $("kbPrefRelatedCountValue").textContent = e.target.value; };
  const speechRate = $("kbPrefSpeechRate");
  if (speechRate) speechRate.oninput = (e) => { $("kbPrefSpeechRateValue").textContent = `${e.target.value}×`; };
  const exportButton = $("kbPrefExport");
  if (exportButton) exportButton.onclick = async () => {
    const bundle = await loadKbBundle();
    const status = $("kbPrefStatus");
    if (!bundle) { if (status) status.textContent = "No local knowledge base to download."; return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "classroom-knowledge-base.json"; a.click(); URL.revokeObjectURL(url);
    if (status) status.textContent = `Downloaded ${bundle.notes.length.toLocaleString()} notes.`;
  };
  const exportBookButton = $("kbPrefExportBook");
  if (exportBookButton) exportBookButton.onclick = async () => {
    const bundle = await loadKbBundle();
    const status = $("kbPrefStatus");
    if (!bundle) { if (status) status.textContent = "No local knowledge base to download."; return; }
    const book = kb.bundleToMarkdown(bundle);
    const url = URL.createObjectURL(new Blob([book], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "classroom-knowledge-book.md"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (status) status.textContent = `Downloaded a study book with ${bundle.notes.length.toLocaleString()} notes.`;
  };
  const clearButton = $("kbPrefClear");
  if (clearButton) clearButton.onclick = async () => {
    await removeKbBundle();
    await import("./kb.js").then(({ refreshKb }) => refreshKb());
    const statusModel = kbLocalStatusModel("cleared");
    const status = $("kbPrefStatus");
    if (status) status.textContent = statusModel.message;
    document.getElementById(statusModel.focusTarget)?.focus();
  };
}

function openSettingsModal() {
  configureKbSettingsUi().catch(() => {});
  const list = $("classesList");
  list.innerHTML = "";
  if (allCourses.length === 0) {
    list.innerHTML = `<div class="empty">No courses loaded yet.</div>`;
  } else {
    for (const c of allCourses) {
      const row = document.createElement("label");
      row.className = "class-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !hiddenCourseIds.has(c.id);
      cb.dataset.id = c.id;
      const name = document.createElement("span");
      name.textContent = c.name || "(untitled)";
      row.append(cb, name);
      list.appendChild(row);
    }
  }
  const showSub = $("prefShowSubmitted"); if (showSub) showSub.checked = !!displayPrefs.showSubmitted;
  const showOver = $("prefShowOverdue"); if (showOver) showOver.checked = !!displayPrefs.showOverdueInDoNow;
  const language = $("prefLanguage"); if (language) language.value = displayPrefs.language === "sk" ? "sk" : "en";
  switchSettingsTab("classes");
  $("settingsModal").hidden = false;
}

function switchSettingsTab(name) {
  document.querySelectorAll(".settings-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
    t.setAttribute("aria-selected", t.dataset.tab === name ? "true" : "false");
  });
  document.querySelectorAll(".settings-pane").forEach((p) => {
    p.hidden = p.dataset.pane !== name;
  });
}

async function saveSettingsAndReload() {
  const prevHidden = new Set(hiddenCourseIds);
  const newHidden = new Set();
  $("classesList").querySelectorAll("input[type=checkbox]").forEach((cb) => {
    if (!cb.checked) newHidden.add(cb.dataset.id);
  });
  hiddenCourseIds = newHidden;
  saveHiddenCourses(hiddenCourseIds);

  const showSub = $("prefShowSubmitted");
  const showOver = $("prefShowOverdue");
  displayPrefs = {
    ...displayPrefs,
    showSubmitted: showSub ? showSub.checked : displayPrefs.showSubmitted,
    showOverdueInDoNow: showOver ? showOver.checked : displayPrefs.showOverdueInDoNow,
    language: $("prefLanguage")?.value === "sk" ? "sk" : "en",
  };
  saveDisplayPrefsLocal(displayPrefs);
  applyTheme($("prefTheme")?.value);

  import("./kb.js").then(({ saveKbSettings, applyKbDensity }) => {
    saveKbSettings({
      tutorEnabled: $("kbPrefTutorEnabled")?.checked,
      tutorEffort: $("kbPrefTutorEffort")?.value,
      defaultScope: $("kbPrefScope")?.value,
      defaultSort: $("kbPrefSort")?.value,
      relatedCount: $("kbPrefRelatedCount")?.value,
      density: $("kbPrefDensity")?.value,
      copyFormat: $("kbPrefCopyFormat")?.value,
      speechRate: $("kbPrefSpeechRate")?.value,
      autoBuild: $("kbPrefAutoBuild")?.checked,
    });
    const pinned = [...($("kbPinnedCoursesList")?.querySelectorAll("input:checked") || [])].map((input) => input.value);
    kb.saveKbPinnedCourses(pinned);
    applyKbDensity();
  }).catch(() => {});
  pushPrefsToServer();
  $("settingsModal").hidden = true;

  const classesChanged = prevHidden.size !== hiddenCourseIds.size ||
    [...prevHidden].some((id) => !hiddenCourseIds.has(id)) ||
    [...hiddenCourseIds].some((id) => !prevHidden.has(id));

  if (classesChanged && accessToken) {
    setStatus("Reloading…");
    const epoch = ++sessionEpoch;
    try { await loadReport(epoch); }
    catch (e) { if (epoch === sessionEpoch) setStatus(e.message, true); }
  } else if (window.__renderAll) {
    window.__renderAll();
  }
}

function openFeedbackModal() {
  $("feedbackText").value = "";
  $("feedbackStatus").textContent = "";
  $("feedbackCategory").value = "bug";
  $("feedbackModal").hidden = false;
}

async function sendFeedback() {
  const text = $("feedbackText").value.trim();
  const category = $("feedbackCategory").value;
  if (!text) { $("feedbackStatus").textContent = "Write something first."; return; }
  $("feedbackStatus").textContent = "Sending…";
  try {
    const r = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ text, category }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      $("feedbackStatus").textContent = `Failed: ${data.error || r.status}`;
      return;
    }
    $("feedbackStatus").textContent = "Thanks! Sent.";
    setTimeout(() => { $("feedbackModal").hidden = true; }, 800);
  } catch (e) {
    $("feedbackStatus").textContent = `Failed: ${e.message}`;
  }
}

function applySort(items) {
  if (currentSort === "default") return items;
  const copy = [...items];
  const dueOf = (a) => dueDateObj(a)?.getTime() ?? Infinity;
  const minOf = (a) => a.enrichment?.estimatedMinutes ?? Infinity;
  const courseOf = (a) => (a.courseName || "").toLowerCase();
  switch (currentSort) {
    case "due-asc": copy.sort((a, b) => dueOf(a) - dueOf(b)); break;
    case "due-desc": copy.sort((a, b) => dueOf(b) - dueOf(a)); break;
    case "class-asc": copy.sort((a, b) => courseOf(a).localeCompare(courseOf(b))); break;
    case "class-desc": copy.sort((a, b) => courseOf(b).localeCompare(courseOf(a))); break;
    case "time-asc": copy.sort((a, b) => minOf(a) - minOf(b)); break;
    case "time-desc": copy.sort((a, b) => (minOf(b) === Infinity ? -1 : minOf(b)) - (minOf(a) === Infinity ? -1 : minOf(a))); break;
  }
  return copy;
}

// Sign-in is a full-page redirect, never a popup — see auth-redirect.js.
// It also needs no Google script to have loaded yet, so it can't fail with
// "Google client not loaded yet".
$("loginBtn").addEventListener("click", () => { startRedirectSignIn("select_account"); });

$("switchBtn").addEventListener("click", () => { closeMenu(); revokeServerToken().then(switchAccount); });
$("logoutBtn").addEventListener("click", () => {
  closeMenu();
  clearToken();
  revokeServerToken();
  setView("planner");
  try { localStorage.removeItem(USER_HINT_KEY); } catch {}
  try { localStorage.removeItem(USER_PROFILE_KEY); } catch {}
  sessionEpoch++;
  prefsLoadedFromServer = false;
  $("welcome").hidden = false;
  const mw = $("menuWrap"); if (mw) mw.hidden = true;
  const sb = $("sidebar"); if (sb) sb.hidden = true;
  $("userInfo").hidden = true;
  $("userInfo").textContent = "";
  const mu = $("menuUser"); if (mu) { mu.hidden = true; mu.textContent = ""; }
  const su = $("sidebarUser"); if (su) { su.hidden = true; su.textContent = ""; }
  $("report").hidden = true;
  $("statBar").innerHTML = "";
  $("doNowList").innerHTML = "";
  $("weekList").innerHTML = "";
  $("todayList").innerHTML = "";
  $("fullList").innerHTML = "";
  $("announcementsList").innerHTML = "";
  $("announcementsWrap").hidden = true;
  setStatus("");
  updateViewToggle();
});

const USER_PROFILE_KEY = "cwa_user_profile";

function loadCachedProfile() {
  try { return JSON.parse(localStorage.getItem(USER_PROFILE_KEY) || "null"); } catch { return null; }
}
function saveCachedProfile(p) {
  try { localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(p)); } catch {}
}

async function fetchUserName(useCache = true) {
  if (useCache) {
    const cached = loadCachedProfile();
    if (cached && cached.name) {
      fetchUserName(false).then((fresh) => {
        if (fresh && fresh.name && fresh.name !== cached.name) {
          // background update — could re-render header here
        }
      }).catch(() => {});
      return cached;
    }
  }
  try {
    const r = await fetchWithTimeout("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.email) storeUserHint(data.email);
    const info = { name: data.given_name || data.name || data.email || null, email: data.email || null };
    if (info.name) saveCachedProfile(info);
    return info;
  } catch {
    return null;
  }
}

function networkError(cause) {
  const err = new Error(isTimeoutError(cause)
    ? "Google didn't respond in time. If your browser blocks third-party cookies or trackers for this site, allow them and try again."
    : `Couldn't reach Google: ${cause?.message || "network error"}`);
  err.status = 0;
  return err;
}

async function gFetch(url) {
  const call = () => fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  let r;
  try {
    r = await call();
  } catch (e) {
    throw networkError(e);
  }
  if (r.status === 401) {
    // Every route, in the same order boot uses — not GIS silent auth alone.
    const token = await recoverAccessToken({ useStored: false });
    if (token) {
      try {
        r = await call();
      } catch (e) {
        throw networkError(e);
      }
    }
    if (r.status === 401) {
      clearToken();
      const err = new Error("Session expired — sign in again.");
      err.status = 401;
      throw err;
    }
  }
  if (!r.ok) {
    const err = new Error(`Classroom API ${r.status}: ${await r.text().catch(() => "")}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function handleWrongAccount() {
  // The cached/auto-restored Google account is not a Classroom account
  // (e.g. a personal account). Clear it so we don't loop on the 400, and
  // drop back to the welcome screen with a clear, actionable message.
  clearToken();
  revokeServerToken();
  sessionEpoch++;
  prefsLoadedFromServer = false;
  try { localStorage.removeItem(USER_HINT_KEY); } catch {}
  try { localStorage.removeItem(USER_PROFILE_KEY); } catch {}
  const mw = $("menuWrap"); if (mw) mw.hidden = true;
  const sb = $("sidebar"); if (sb) sb.hidden = true;
  $("userInfo").hidden = true;
  $("userInfo").textContent = "";
  $("userInfo").setAttribute("aria-hidden", "true");
  setView("planner");
  $("welcome").hidden = false;
  setStatus("That Google account isn't a Classroom account. Sign in with your school Google account to continue.", true);
  updateViewToggle();
}

// The Calendar scope is requested ONLY when someone turns the Settings switch
// on — never at sign-in. kb.js raises this rather than importing the auth
// plumbing, which would drag app.js's whole subtree into the Study module.
window.addEventListener("cwa-request-calendar-scope", (event) => {
  const { scope, prompt, loginHint } = event.detail || {};
  if (!scope) return;
  void startRedirectSignIn(prompt || "consent", { scope, loginHint: loginHint || loadUserHint() });
});

// Flipping the switch hides or unhides the calendar. Never deletes: that is a
// separate, deliberate button (ROADMAP 6b), because an irreversible action
// behind a toggle is how someone loses a term of ✓-marked work by mis-tapping.
window.addEventListener("cwa-calendar-visibility", (event) => {
  const visible = event.detail?.visible === true;
  void (async () => {
    const account = currentAccountId();
    const stored = calendarStateFor(loadCalendarState(), account);
    if (!accessToken || !account) return;
    try {
      if (visible) {
        // Turning it back on: unhide first if there is something to unhide,
        // then let the sync repair whatever drifted while it was off.
        if (stored.calendarId) {
          const client = createCalendarClient({ request: googleCalendarRequest(() => accessToken) });
          await client.setVisibility(stored.calendarId, true);
        }
        await syncCalendar(sessionEpoch);
      } else if (stored.calendarId) {
        const client = createCalendarClient({ request: googleCalendarRequest(() => accessToken) });
        await client.setVisibility(stored.calendarId, false);
      }
    } catch (error) {
      console.warn("[calendar] visibility change failed:", error?.status || "", error?.message || error);
    }
    window.dispatchEvent(new CustomEvent("cwa-calendar-synced"));
  })();
});

// The only destructive path, and deliberately not the switch. kb.js has
// already confirmed with the student by the time this fires.
window.addEventListener("cwa-calendar-remove", () => {
  void (async () => {
    const account = currentAccountId();
    const stored = calendarStateFor(loadCalendarState(), account);
    if (!accessToken || !account || !stored.calendarId) return;
    try {
      const client = createCalendarClient({ request: googleCalendarRequest(() => accessToken) });
      await client.deleteCalendar(stored.calendarId);
      // Forget the id AND switch sync off: leaving it on would recreate the
      // calendar on the next page load, which is not what "remove" means.
      saveCalendarState(setCalendarStateFor(loadCalendarState(), account, { calendarId: "", enabled: false, lastSyncAt: "" }));
    } catch (error) {
      console.warn("[calendar] remove failed:", error?.status || "", error?.message || error);
    }
    window.dispatchEvent(new CustomEvent("cwa-calendar-synced"));
  })();
});

window.addEventListener("cwa-classroom-auth-error", (event) => {
  if (classroomAuthRecoveryModel(event?.detail?.status).resetSession) handleWrongAccount();
});

function switchAccount() {
  const mw = $("menuWrap"); if (mw) mw.hidden = true;
  // Force the account chooser so the user can pick their school account.
  startRedirectSignIn("select_account");
}

async function onSignedIn() {
  const epoch = ++sessionEpoch;
  $("welcome").hidden = true;
  const mw = $("menuWrap"); if (mw) mw.hidden = false;
  const sb = $("sidebar"); if (sb) sb.hidden = false;
  updateViewToggle();
  const LOADING = "Loading your courses…";
  setStatus(LOADING);
  // Belt and braces for the try/finally below: that only runs once the awaited
  // chain settles, so a request that hangs forever would still strand the user
  // on an empty page. This fires regardless.
  const watchdog = setTimeout(() => {
    if (epoch !== sessionEpoch || currentView !== "planner") return;
    if (!$("report").hidden || !$("welcome").hidden) return;
    $("welcome").hidden = false;
    setStatus("Still waiting on Google — the request looks blocked. Try refreshing, or allow third-party cookies for this site.", true);
  }, SIGNIN_WATCHDOG_MS);
  try {
    await hydrateSignedInView(epoch);
    if (epoch === sessionEpoch) restoreSessionPosition(epoch);
    // After the report, so the assignments exist; not awaited, so a slow
    // Calendar API never delays the page the student came for.
    if (epoch === sessionEpoch) void syncCalendar(epoch);
  } catch (e) {
    if (epoch === sessionEpoch) setStatus(e?.message || "Sign-in failed.", true);
  } finally {
    clearTimeout(watchdog);
    // #welcome is hidden above but #report is only unhidden at the very end of
    // loadReport. Anything that throws or bails out in between used to leave
    // both hidden — a blank page with no way forward but a manual reload.
    // Never exit this function in that state.
    if (epoch === sessionEpoch && currentView === "planner"
        && $("report").hidden && $("welcome").hidden) {
      $("welcome").hidden = false;
      if (!statusEl.textContent || statusEl.textContent === LOADING) {
        setStatus("Couldn't load your Classroom data — try refreshing.", true);
      }
    }
  }
}

async function hydrateSignedInView(epoch) {
  fetchUserName().then((info) => {
    if (epoch !== sessionEpoch) return;
    if (info && info.name) {
      const text = `Signed in as ${info.name}`;
      $("userInfo").textContent = text;
      $("userInfo").hidden = false;
      $("userInfo").removeAttribute("aria-hidden");
      const mu = $("menuUser");
      if (mu) { mu.textContent = text; mu.hidden = false; }
      const su = $("sidebarUser");
      if (su) { su.textContent = info.name; su.hidden = false; }
    }
  });
  const hasLocalPrefs = localStorage.getItem(COURSES_HIDDEN_KEY) !== null || localStorage.getItem(DISPLAY_PREFS_KEY) !== null;
  if (!prefsLoadedFromServer && !hasLocalPrefs) {
    await syncPrefsFromServer();
  } else if (!prefsLoadedFromServer) {
    syncPrefsFromServer().then((ok) => {
      if (!ok || epoch !== sessionEpoch) return;
      if (window.__renderAll) window.__renderAll();
    });
  }
  try {
    await loadReport(epoch);
  } catch (e) {
    if (epoch === sessionEpoch) setStatus(e.message, true);
  }
  if (epoch === sessionEpoch) {
    import("./kb.js").then(({ maybeAutoBuildKb }) => maybeAutoBuildKb()).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Google Calendar sync.
//
// Runs here rather than in kb.js because the assignments live here: the
// calendar mirrors Classroom coursework, not the notes corpus. Only ever on
// open, never in the background — decided 2026-09-09, and it is what lets this
// feature exist with no server at all.
// ---------------------------------------------------------------------------

let calendarSyncInFlight = false;

async function syncCalendar(epoch) {
  const account = currentAccountId();
  if (calendarSyncInFlight || !calendarSyncReady(account) || !accessToken) return null;
  calendarSyncInFlight = true;
  try {
    const client = createCalendarClient({
      request: googleCalendarRequest(() => accessToken),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    });
    const stored = calendarStateFor(loadCalendarState(), account);
    const calendarId = await client.ensureCalendar(stored.calendarId, {
      onCreate: (id) => saveCalendarState(setCalendarStateFor(loadCalendarState(), account, { calendarId: id })),
    });
    if (epoch !== sessionEpoch) return null;

    // Hidden courses are filtered OUT here, which is what makes hiding a class
    // in Settings remove its events and un-hiding put them back — the plan
    // treats anything absent from the corpus as something to delete.
    const wanted = syncableAssignments(allAssignments, { hiddenCourseIds, dismissedIds });
    const existing = await client.listManagedEvents(calendarId);
    if (epoch !== sessionEpoch) return null;

    // `shouldDropEarly` stops returning coursework due more than STALE_DAYS ago,
    // so beyond that point "missing from the corpus" stops meaning "deleted in
    // Classroom". Reconcile is bounded to the window we can actually see, or it
    // would erase the ✓ record of everything finished more than a fortnight ago.
    const horizon = new Date(Date.now() - (STALE_DAYS + 1) * 86400000).toISOString().slice(0, 10);
    const { ops, counts } = calendarSyncPlan(wanted, existing, { reconcileAfter: horizon });
    const { done, failed } = await client.applyPlan(calendarId, ops);
    saveCalendarState(setCalendarStateFor(loadCalendarState(), account, { lastSyncAt: new Date().toISOString() }));
    console.info("[calendar] sync", { ...counts, applied: done.length, failed: failed.length });
    if (failed.length) console.warn("[calendar] failures", failed.slice(0, 5));
    window.dispatchEvent(new CustomEvent("cwa-calendar-synced"));
    return { counts, failed };
  } catch (error) {
    // Never let a calendar problem break the planner. The status line in
    // Settings is where this surfaces, not an alert over someone's homework.
    console.warn("[calendar] sync failed:", error?.status || "", error?.message || error);
    return null;
  } finally {
    calendarSyncInFlight = false;
  }
}

function dueDateObj(a) {
  if (!a.dueDate) return null;
  const { year, month, day } = a.dueDate;
  const t = a.dueTime || {};
  return new Date(year, month - 1, day, t.hours ?? 23, t.minutes ?? 59);
}

function isPending(a) {
  const s = a.submission?.state;
  return !s || s === "NEW" || s === "CREATED" || s === "RECLAIMED_BY_STUDENT";
}

function isPostedSinceYesterday(a) {
  if (!a.creationTime) return false;
  const created = new Date(a.creationTime);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 1);
  return created >= since;
}

function daysUntil(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function isInScope(a) {
  if (a.kind !== "assignment") return false;
  if (!isPending(a) && !displayPrefs.showSubmitted) return false;
  const due = dueDateObj(a);
  if (!due) return false;
  const d = daysUntil(due);
  return d >= -OVERDUE_GRACE_DAYS && d <= WEEK_DAYS;
}

async function loadReport(epoch) {
  lazyEnrichTriggered = false;
  let coursesResp;
  try {
    coursesResp = await gFetch("https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=100");
  } catch (e) {
    // 400/403 from Classroom almost always means the signed-in Google account
    // is NOT a school/Classroom account (e.g. a cached personal account).
    // Don't stay stuck on the wrong account — clear it, bounce to the welcome
    // screen, and let the user pick their school account from the chooser.
    if (classroomAuthRecoveryModel(e?.status).resetSession) {
      handleWrongAccount();
      return;
    }
    if (epoch === sessionEpoch) setStatus(e.message, true);
    return;
  }
  if (epoch !== sessionEpoch) return;
  allCourses = coursesResp.courses || [];
  const courses = allCourses.filter((c) => !hiddenCourseIds.has(c.id));

  const perCourse = await Promise.all(
    courses.map(async (course) => {
      const [cwResp, subResp, matResp, annResp] = await Promise.all([
        gFetch(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork?pageSize=100&orderBy=updateTime%20desc&courseWorkStates=PUBLISHED`).catch(() => ({})),
        gFetch(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork/-/studentSubmissions?userId=me&pageSize=200`).catch(() => ({})),
        gFetch(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWorkMaterials?pageSize=50&orderBy=updateTime%20desc&courseWorkMaterialStates=PUBLISHED`).catch(() => ({})),
        gFetch(`https://classroom.googleapis.com/v1/courses/${course.id}/announcements?pageSize=20&orderBy=updateTime%20desc&announcementStates=PUBLISHED`).catch(() => ({})),
      ]);
      const submissions = subResp.studentSubmissions || [];
      const subByCw = new Map(submissions.map((s) => [s.courseWorkId, s]));
      const assignments = (cwResp.courseWork || []).map((cw) => ({
        ...cw,
        kind: "assignment",
        courseName: course.name,
        courseId: course.id,
        submission: subByCw.get(cw.id) || null,
      }));
      const materials = (matResp.courseWorkMaterial || []).map((m) => ({
        ...m,
        kind: "material",
        courseName: course.name,
        courseId: course.id,
      }));
      const announcements = (annResp.announcements || []).map((an) => ({
        ...an,
        kind: "announcement",
        title: (an.text || "").slice(0, 120) || "(announcement)",
        description: an.text || "",
        courseName: course.name,
        courseId: course.id,
      }));
      return [...assignments, ...materials, ...announcements];
    })
  );

  if (epoch !== sessionEpoch) return;
  const allWork = perCourse.flat().filter((a) => !shouldDropEarly(a));
  allAssignments = allWork;
  const inScope = allWork.filter(isInScope);

  // Hydrate from cache across everything, not just what is in scope. Handing
  // only inScope to this left a submitted assignment — which drops out of
  // scope the moment it is turned in — rendering with no type and no estimate
  // even though its enrichment was sitting in the cache. Requests are still
  // limited to in-scope work; this only attaches what is already known.
  applyCachedEnrichments(allWork);
  const need = inScope.filter((a) => !a.enrichment);

  const renderAll = () => {
    const visible = allWork.filter((a) => !dismissedIds.has(a.id));
    const visibleInScope = visible.filter(isInScope);
    renderStatBar(visible, visibleInScope);
    renderPinned(visible);
    renderAnnouncements(visible);
    renderUpcoming(visibleInScope);
    renderTodayNew(visible);
    renderFull(visible);
  };
  window.__renderAll = renderAll;
  renderAll();
  $("report").hidden = false;
  setStatus("");

  pruneChats(inScope.map((a) => a.id));

  if (need.length > 0) {
    let remaining = need.length;
    setStatus(`Analyzing ${remaining} new assignment${remaining === 1 ? "" : "s"}…`);
    const onProgress = (n) => {
      if (epoch !== sessionEpoch) return;
      remaining -= n;
      renderAll();
      if (remaining > 0) setStatus(`Analyzing ${remaining} more…`);
      else setStatus("");
    };
    fetchEnrichments(need, onProgress).then((failed) => {
      if (epoch !== sessionEpoch) return;
      maybeLazyEnrichRest({ auto: true });
      if (!failed) return;
      // Say so rather than leaving the assignments silently unanalyzed. This
      // is what a removed or unreachable upstream model looks like from here.
      setStatus(enrichFailureMessage(failed), true);
    });
  } else {
    // Nothing in scope means the branch above never runs — and with it, the
    // only trigger for the out-of-scope pass. An assignment with no due date
    // (or one due beyond the window) would otherwise never be analyzed at
    // all, while still rendering as though it were being worked on.
    maybeLazyEnrichRest({ auto: true });
  }
}

function applyCachedEnrichments(items) {
  const cache = loadEnrichCache();
  const need = [];
  for (const a of items) {
    const key = enrichCacheKey(a);
    if (cache[key]) a.enrichment = cache[key];
    else need.push(a);
  }
  return need;
}

const BATCH_SIZE = 5;
// Assignments the AI was asked about and could not analyze. The spinning
// priority dot means "not analyzed yet", and without this it never stops:
// a failed enrichment is deliberately not cached (so it retries on the next
// load), which leaves the card looking permanently in-flight. Session-only —
// a reload should try again.
const enrichFailedIds = new Set();
// Assignments with a request queued or in flight. The spinning dot means
// "being analyzed", and it was previously drawn for anything without an
// enrichment — including assignments nothing had ever asked about, which spin
// for the life of the page. Only these get the spinner.
const enrichPendingIds = new Set();
// The upstream reason for the most recent failure, shown to the user so a
// rate limit is distinguishable from a dead model.
let lastEnrichFailure = "";
// Enrichment is slower than an ordinary request — the server may try two
// models for each of five assignments — so it gets a longer budget than
// NET_TIMEOUT_MS. It still needs one: a bare fetch() against a provider that
// accepts the connection and never answers hangs forever, and the only thing
// the user sees is "Analyzing N more…" that never finishes.
const ENRICH_TIMEOUT_MS = 45_000;

async function enrichBatch(batch) {
  try {
    const r = await fetchWithTimeout("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({
        assignments: batch.map((a) => ({
          id: a.id,
          courseName: a.courseName,
          title: a.title,
          description: a.description,
          workType: a.workType,
          contentHash: contentHash(a),
        })),
      }),
    }, ENRICH_TIMEOUT_MS);
    if (!r.ok) {
      // The whole request failed, so there are no per-assignment details to
      // report — this is the case that left nothing to look at anywhere.
      const body = await r.text().catch(() => "");
      lastEnrichFailure = `/api/enrich HTTP ${r.status} ${body.slice(0, 300)}`;
      console.error("[enrich] request failed:", r.status, body.slice(0, 500));
      return [];
    }
    const data = await r.json();
    const list = data.enrichments || [];
    for (const e of list) {
      if (e?.error) console.error("[enrich] assignment", e.id, e.error, e.detail || "(no detail)");
    }
    return list;
  } catch (e) {
    lastEnrichFailure = isTimeoutError(e)
      ? `/api/enrich timed out after ${ENRICH_TIMEOUT_MS / 1000}s`
      : `/api/enrich ${e.name || "failed"}: ${e.message || ""}`;
    console.error("[enrich] request threw:", e);
    return [];
  }
}

function enrichFailureMessage(failed) {
  const n = `${failed} assignment${failed === 1 ? "" : "s"}`;
  const why = lastEnrichFailure ? ` — ${lastEnrichFailure}` : "";
  return `AI couldn't analyze ${n}${why}. Reload to retry.`;
}

/** Returns the number of assignments the AI could not analyze. */
async function fetchEnrichments(need, onProgress) {
  if (need.length === 0) return 0;
  let failed = 0;
  for (const a of need) enrichPendingIds.add(a.id);
  for (let i = 0; i < need.length; i += BATCH_SIZE) {
    const batch = need.slice(i, i + BATCH_SIZE);
    const enrichments = await enrichBatch(batch);
    const byId = new Map(enrichments.map((e) => [e.id, e]));
    const cache = loadEnrichCache();
    for (const a of batch) {
      const e = byId.get(a.id);
      // The server answers 200 with {id, error} per assignment it could not
      // analyze — a dead upstream model reads exactly like this. Storing that
      // object counted as a result, so the assignment was never retried and
      // sat permanently blank. Only a real enrichment is worth keeping.
      enrichPendingIds.delete(a.id);
      if (e && !e.error) {
        a.enrichment = e;
        enrichFailedIds.delete(a.id);
        cache[enrichCacheKey(a)] = e;
      } else {
        enrichFailedIds.add(a.id);
        // Fall back through detail -> error code -> "no result", so the
        // message always names something. parse_failed used to carry no
        // detail at all, which left the reason blank.
        lastEnrichFailure = e?.detail || e?.error || "server returned no result for this assignment";
        failed += 1;
      }
    }
    saveEnrichCache(cache);
    if (onProgress) onProgress(batch.length);
  }
  return failed;
}

function renderStatBar(all, inScope) {
  const thisWeek = all.filter((a) => {
    if (a.kind !== "assignment") return false;
    if (!isPending(a)) return false;
    const due = dueDateObj(a);
    if (!due) return false;
    const d = daysUntil(due);
    return d >= 0 && d <= 7;
  });
  const overdue = all.filter((a) => {
    if (a.kind !== "assignment") return false;
    if (!isPending(a)) return false;
    const due = dueDateObj(a);
    if (!due) return false;
    const d = daysUntil(due);
    return d < 0 && d >= -OVERDUE_GRACE_DAYS;
  }).length;
  const totalMinutes = thisWeek.reduce((s, a) => s + (a.enrichment?.estimatedMinutes || 0), 0);
  const hours = Math.round(totalMinutes / 60 * 10) / 10;
  $("statBar").innerHTML = "";
  const stats = [
    { label: "This week", value: thisWeek.length },
    { label: "Overdue", value: overdue, alert: overdue > 0 },
    { label: "Est. hours", value: hours || "—" },
  ];
  for (const s of stats) {
    const el = document.createElement("div");
    el.className = "stat" + (s.alert ? " alert" : "");
    el.innerHTML = `<strong></strong><span class="label"></span>`;
    el.querySelector("strong").textContent = s.value;
    el.querySelector(".label").textContent = s.label;
    $("statBar").appendChild(el);
  }

  const sortOptions = [
    { value: "default", label: "Default" },
    { value: "due-asc", label: "Due · soonest first" },
    { value: "due-desc", label: "Due · latest first" },
    { value: "class-asc", label: "Class · A–Z" },
    { value: "class-desc", label: "Class · Z–A" },
    { value: "time-asc", label: "Time · shortest first" },
    { value: "time-desc", label: "Time · longest first" },
  ];
  const sortWrap = document.createElement("div");
  sortWrap.className = "sort-stat";
  const current = sortOptions.find((o) => o.value === currentSort) || sortOptions[0];

  sortWrap.innerHTML = `
    <span class="sort-label">Sort</span>
    <div class="dropdown">
      <button class="dropdown-toggle" type="button" aria-haspopup="listbox" aria-expanded="false">
        <span class="dropdown-current"></span>
        <svg class="dropdown-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <ul class="dropdown-menu" role="listbox" hidden></ul>
    </div>
  `;
  sortWrap.querySelector(".dropdown-current").textContent = current.label;
  const menu = sortWrap.querySelector(".dropdown-menu");
  const toggle = sortWrap.querySelector(".dropdown-toggle");
  for (const opt of sortOptions) {
    const li = document.createElement("li");
    li.className = "dropdown-item" + (opt.value === currentSort ? " selected" : "");
    li.dataset.value = opt.value;
    li.setAttribute("role", "option");
    li.textContent = opt.label;
    li.addEventListener("click", () => {
      currentSort = opt.value;
      sessionStorage.setItem(SORT_KEY, currentSort);
      closeDropdown();
      if (window.__renderAll) window.__renderAll();
    });
    menu.appendChild(li);
  }

  const openDropdown = () => {
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    setTimeout(() => document.addEventListener("click", outsideClose), 0);
  };
  const closeDropdown = () => {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outsideClose);
  };
  const outsideClose = (e) => {
    if (!sortWrap.contains(e.target)) closeDropdown();
  };
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) openDropdown(); else closeDropdown();
  });

  $("statBar").appendChild(sortWrap);
}

function priorityClass(weight) {
  if (!weight) return "";
  return `p${Math.max(1, Math.min(5, Math.round(weight)))}`;
}

// Fixed mapping from label text → color family. Deterministic across devices.
// Each label belongs to exactly one family so the same word never gets two colors.
// Dot and tag colour per kind. The canonical twelve come first in each list;
// the trailing entries are retired kinds, kept so an enrichment cached before
// the vocabulary shrank still gets a colour rather than falling back to grey.
const LABEL_FAMILIES = {
  // Red — high-stakes assessment
  assess: ["test", "quiz", "exam", "midterm", "final"],
  // Green — content to consume
  consume: ["reading", "video", "listening", "review"],
  // Amber — written deliverable to submit
  write: ["essay", "project", "translation", "report", "analysis", "research"],
  // Blue — practice / homework
  practice: ["worksheet", "practice", "notes", "problem set", "problems", "exercises", "vocabulary", "drawing"],
  // Purple — live performance in front of class
  perform: ["presentation", "interview", "oral", "viva", "recording"],
  // Teal — collaborative / open-ended
  discuss: ["lab", "discussion", "question"],
};

function labelVerbClass(label) {
  if (!label) return "";
  const l = String(label).toLowerCase().trim();
  for (const family in LABEL_FAMILIES) {
    if (LABEL_FAMILIES[family].includes(l)) return `kind-${family}`;
  }
  return "";
}

function deriveLabel(a) {
  const e = a.enrichment;
  if (e?.taskKind) return e.taskKind;
  // Route every client-side guess through the shared vocabulary, so this
  // fallback cannot reintroduce a label the server would never produce — which
  // is how "Question" survived being removed from the prompt.
  if (a.workType === "SHORT_ANSWER_QUESTION" || a.workType === "MULTIPLE_CHOICE_QUESTION") {
    return normalizeTaskKind("question");
  }
  const at = e?.actionType;
  if (at === "in_person") return "Test";
  if (at === "read_only") return "Reading";
  if (at === "study_only") return "Study";
  return null;
}

function assignmentCard(a) {
  const isMaterial = a.kind === "material";
  const isAnnouncement = a.kind === "announcement";
  const isPassive = isMaterial || isAnnouncement;
  const due = isPassive ? null : dueDateObj(a);
  const e = a.enrichment;
  const verb = isMaterial ? "Material" : isAnnouncement ? "Announcement" : deriveLabel(a);
  const verbCls = isPassive ? "material" : labelVerbClass(verb);
  const isInPerson = e?.actionType === "in_person";

  const isSubmitted = !isPassive && isSubmittedState(a.submission?.state);

  const el = document.createElement("div");
  let stateCls = "";
  if (!isPassive) {
    if (isSubmitted) stateCls = " state-submitted";
    else if (due && daysUntil(due) < 0 && isPending(a)) stateCls = " state-overdue";
  }
  el.className = "assignment" + (pinnedIds.has(a.id) ? " pinned" : "") + stateCls;

  const dot = document.createElement("div");
  if (isPassive) {
    dot.className = "priority-dot material-dot";
  } else if (!e && enrichPendingIds.has(a.id)) {
    // A request is genuinely in flight for this one.
    dot.className = "priority-dot loading";
    dot.title = "Analyzing…";
  } else if (!e && enrichFailedIds.has(a.id)) {
    dot.className = "priority-dot failed";
    dot.title = "AI analysis unavailable — reload to retry";
  } else if (!e) {
    // Nothing has asked about this assignment yet: past the automatic pass's
    // cap, or outside what has been requested so far. Distinct from both
    // "working on it" and "it failed".
    dot.className = "priority-dot unanalyzed";
    dot.title = "Not analyzed yet";
  } else {
    // Dot color follows the label family so it matches the verb tag and is
    // deterministic across devices (same label → same dot, every time).
    dot.className = `priority-dot ${verbCls || "kind-unknown"}`;
    if (e.weight) dot.title = `Priority ${e.weight}/5`;
  }

  const body = document.createElement("div");
  body.className = "assignment-body";

  const titleLine = document.createElement("div");
  // Named so the corner action cluster can be cleared by the title line alone.
  titleLine.className = "title-line";
  if (verb) {
    const verbEl = document.createElement("span");
    verbEl.className = `verb ${verbCls}`;
    verbEl.textContent = verb;
    titleLine.appendChild(verbEl);
  }
  const titleEl = document.createElement("span");
  titleEl.className = "title";
  if (isAnnouncement) {
    const classTag = document.createElement("span");
    classTag.className = "ann-class";
    classTag.textContent = a.courseName;
    titleEl.appendChild(classTag);
    titleEl.appendChild(document.createTextNode(a.title || "(announcement)"));
  } else {
    titleEl.textContent = a.title || "(untitled)";
  }
  titleLine.appendChild(titleEl);

  body.appendChild(titleLine);

  if (!isPassive && e?.oneLineSummary) {
    const sum = document.createElement("div");
    sum.className = "summary";
    sum.textContent = e.oneLineSummary;
    body.appendChild(sum);
  }

  const meta = document.createElement("div");
  meta.className = "meta";

  if (!isAnnouncement) {
    const courseSpan = document.createElement("span");
    // Named rather than matched by :first-child — the course chip is
    // conditional, so on a card without one that selector would style the due
    // date instead.
    courseSpan.className = "meta-course";
    courseSpan.textContent = a.courseName;
    meta.appendChild(courseSpan);
  }

  if (due) {
    const dueSpan = document.createElement("span");
    const days = daysUntil(due);
    // Submitted work is never overdue, whatever its due date says.
    const chip = dueChipModel(days, { pending: isPending(a) });
    if (chip) {
      dueSpan.textContent = chip.text;
      dueSpan.className = ["meta-due", chip.className].filter(Boolean).join(" ");
      meta.appendChild(dueSpan);
    }
  }

  // How long it will take is only useful while it is still to be done. The
  // kind of work it was stays useful after it is handed in.
  if (!isPassive && !isSubmitted && e?.estimatedMinutes) {
    const eff = document.createElement("span");
    eff.className = "effort";
    eff.textContent = e.estimatedMinutes >= 60
      ? `~${Math.round(e.estimatedMinutes / 60 * 10) / 10}h`
      : `~${e.estimatedMinutes}m`;
    meta.appendChild(eff);
  }

  if (isInPerson) {
    const ip = document.createElement("span");
    ip.textContent = "In-person";
    ip.className = "effort";
    meta.appendChild(ip);
  } else if (isSubmitted) {
    const ts = document.createElement("span");
    ts.textContent = "Submitted";
    ts.className = "submitted";
    meta.appendChild(ts);
  }

  if (a.alternateLink) {
    const open = document.createElement("a");
    open.href = withAuthUser(a.alternateLink);
    open.target = "_blank";
    open.rel = "noopener";
    open.className = "open-link";
    // The word is hidden on phones (see styles.css) to keep the card footer on
    // one line, so the accessible name is stated rather than left to the glyph.
    open.setAttribute("aria-label", "Open in Google Classroom");
    open.title = "Open in Google Classroom";
    const openLabel = document.createElement("span");
    openLabel.className = "open-link-label";
    openLabel.textContent = "Open";
    open.append(openLabel, " ↗");
    open.addEventListener("click", (ev) => ev.stopPropagation());
    meta.appendChild(open);
  }

  // Actions live together in one cluster. Appended individually they were just
  // more items in the wrapping meta row, and on a phone the last of them —
  // usually "🔍 KB" — fell onto a line of its own.
  const actions = document.createElement("div");
  actions.className = "card-actions";

  if (!isPassive) {
    const pin = document.createElement("button");
    pin.className = "card-action pin-btn" + (pinnedIds.has(a.id) ? " pinned" : "");
    pin.title = pinnedIds.has(a.id) ? "Unstar" : "Star";
    pin.textContent = pinnedIds.has(a.id) ? "★" : "☆";
    pin.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (pinnedIds.has(a.id)) pinnedIds.delete(a.id);
      else pinnedIds.add(a.id);
      saveIdSet(PINNED_KEY, pinnedIds);
      if (window.__renderAll) window.__renderAll();
    });
    actions.appendChild(pin);
  }

  if (!isPassive) {
    const kbBtn = document.createElement("button");
    kbBtn.className = "card-action kb-search-btn";
    kbBtn.title = "Search the knowledge base for this topic";
    kbBtn.setAttribute("aria-label", "Search the knowledge base for this topic");
    // The word is hidden on phones; the label above keeps the name.
    kbBtn.append("🔍", Object.assign(document.createElement("span"), { className: "card-action-label", textContent: " KB" }));
    kbBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const topic = [a.courseName, a.title].filter(Boolean).join(" ");
      import("./kb.js")
        .then((m) => m.kbSearchTopic(topic))
        .catch(() => {});
    });
    actions.appendChild(kbBtn);
  }

  if (!isPassive && !due) {
    const del = document.createElement("button");
    del.className = "card-action dismiss-btn";
    del.title = "Hide this assignment";
    del.textContent = "✕";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      dismissedIds.add(a.id);
      saveIdSet(DISMISSED_KEY, dismissedIds);
      if (window.__renderAll) window.__renderAll();
    });
    actions.appendChild(del);
  }

  if (actions.childElementCount > 0) {
    // The clearance the cluster needs when it sits in the card's corner is a
    // function of how many buttons there actually are.
    el.style.setProperty("--action-count", String(actions.childElementCount));
    meta.appendChild(actions);
  }

  body.appendChild(meta);
  el.append(dot, body);
  el.addEventListener("click", () => {
    const isDesktop = window.matchMedia("(min-width: 901px)").matches;
    if (isDesktop && activeAssignment && activeAssignment.id === a.id && !$("ai").hidden) {
      $("ai").hidden = true;
      activeAssignment = null;
      return;
    }
    openAi(a);
  });
  return el;
}

function sortByPriorityThenDue(items) {
  if (currentSort !== "default") return applySort(items);
  return [...items].sort((a, b) => {
    const aw = a.enrichment?.weight || 0;
    const bw = b.enrichment?.weight || 0;
    if (aw !== bw) return bw - aw;
    const ad = dueDateObj(a)?.getTime() ?? Infinity;
    const bd = dueDateObj(b)?.getTime() ?? Infinity;
    return ad - bd;
  });
}

function renderUpcoming(inScope) {
  const hNow = $("hDoNow");
  const hWeek = $("hWeek");
  const weekList = $("weekList");

  if (currentSort === "default") {
    hNow.textContent = "Do today / tomorrow";
    hWeek.hidden = false;
    weekList.hidden = false;
    renderDoNow(inScope);
    renderWeek(inScope);
    return;
  }

  hNow.textContent = "Upcoming";
  hWeek.hidden = true;
  weekList.hidden = true;
  const list = $("doNowList");
  list.innerHTML = "";
  const items = inScope.filter((a) => {
    if (!isPending(a) && !displayPrefs.showSubmitted) return false;
    const due = dueDateObj(a);
    if (!due) return false;
    const d = daysUntil(due);
    return d >= -OVERDUE_GRACE_DAYS && d <= WEEK_DAYS;
  });
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">Nothing upcoming.</div>`;
    return;
  }
  applySort(items).forEach((a) => list.appendChild(assignmentCard(a)));
}

function renderDoNow(inScope) {
  const list = $("doNowList");
  list.innerHTML = "";
  const minDay = displayPrefs.showOverdueInDoNow ? -OVERDUE_GRACE_DAYS : 0;
  const items = inScope.filter((a) => {
    if (!isPending(a) && !displayPrefs.showSubmitted) return false;
    const due = dueDateObj(a);
    if (!due) return false;
    const d = daysUntil(due);
    return d <= 1 && d >= minDay;
  });
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">Nothing urgent for today or tomorrow.</div>`;
    return;
  }
  sortByPriorityThenDue(items).forEach((a) => list.appendChild(assignmentCard(a)));
}

function renderWeek(inScope) {
  const list = $("weekList");
  list.innerHTML = "";
  const items = inScope.filter((a) => {
    if (!isPending(a) && !displayPrefs.showSubmitted) return false;
    const due = dueDateObj(a);
    if (!due) return false;
    const d = daysUntil(due);
    return d >= 2 && d <= WEEK_DAYS;
  });
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">Nothing else due this week.</div>`;
    return;
  }
  const byDay = new Map();
  for (const a of items) {
    const d = daysUntil(dueDateObj(a));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(a);
  }
  const sortedDays = [...byDay.keys()].sort((x, y) => x - y);
  for (const d of sortedDays) {
    const group = document.createElement("div");
    group.className = "day-group";
    const label = document.createElement("div");
    label.className = "day-label";
    const dayDate = new Date(); dayDate.setDate(dayDate.getDate() + d);
    const name = dayDate.toLocaleDateString(undefined, { weekday: "long" });
    const dateText = dayDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const dayItems = byDay.get(d);
    const dayMinutes = dayItems.reduce((s, a) => s + (a.enrichment?.estimatedMinutes || 0), 0);
    label.innerHTML = `<span></span><span class="day-meta"></span>`;
    label.children[0].textContent = `${name} · ${dateText}`;
    label.children[1].textContent = dayMinutes
      ? `${dayItems.length} task${dayItems.length === 1 ? "" : "s"} · ~${dayMinutes >= 60 ? Math.round(dayMinutes / 60 * 10) / 10 + "h" : dayMinutes + "m"}`
      : `${dayItems.length} task${dayItems.length === 1 ? "" : "s"}`;
    group.appendChild(label);
    sortByPriorityThenDue(dayItems).forEach((a) => group.appendChild(assignmentCard(a)));
    list.appendChild(group);
  }
}

function renderTodayNew(all) {
  const list = $("todayList");
  list.innerHTML = "";
  const items = applySort(all.filter((a) => a.kind !== "announcement" && isPostedSinceYesterday(a)));
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">No new assignments posted since yesterday.</div>`;
    return;
  }
  // Work to do first, reading material after — they used to be interleaved.
  const { groups, showLabels } = groupPlannerItems(items);
  for (const group of groups) {
    const wrap = document.createElement("div");
    wrap.className = "course-group";
    if (showLabels) {
      const label = document.createElement("div");
      label.className = "day-label";
      label.textContent = `${group.label} · ${group.items.length}`;
      wrap.appendChild(label);
    }
    group.items.forEach((a) => wrap.appendChild(assignmentCard(a)));
    list.appendChild(wrap);
  }
}

function renderAnnouncements(all) {
  const wrap = $("announcementsWrap");
  const list = $("announcementsList");
  list.innerHTML = "";
  const items = all.filter((a) => a.kind === "announcement");
  if (items.length === 0) { wrap.hidden = true; return; }
  items.forEach((a) => list.appendChild(assignmentCard(a)));
  wrap.hidden = false;
}

function renderPinned(visible) {
  const list = $("pinnedList");
  const wrap = $("pinnedWrap");
  list.innerHTML = "";
  const items = visible.filter((a) => pinnedIds.has(a.id) && (a.kind !== "assignment" || isPending(a)));
  if (items.length === 0) { wrap.hidden = true; return; }
  items.forEach((a) => list.appendChild(assignmentCard(a)));
  wrap.hidden = false;
}

// Cap the automatic pass. Out-of-scope work can be a whole year of
// assignments, and each one is a request against a shared free quota.
const LAZY_ENRICH_MAX = 40;

function maybeLazyEnrichRest({ auto = false } = {}) {
  if (lazyEnrichTriggered) return;
  // Opening the section is one trigger; the automatic pass after load is the
  // other. Without the second, an assignment outside the -3..+7 day window is
  // never analyzed at all unless the user happens to expand that section.
  if (!auto && !$("restWrap").open) return;
  lazyEnrichTriggered = true;
  // Not gated on isPending: submitted work was excluded here AND by
  // isInScope (which honours the showSubmitted display preference, off by
  // default), so once an assignment was handed in nothing could ever analyze
  // it and it showed no type at all. Whether completed work is listed is a
  // display choice; it should not decide whether it gets a type.
  const candidates = allAssignments
    .filter((a) => isEnrichCandidate({
      kind: a.kind,
      submissionState: a.submission?.state,
      stale: isStale(a),
      dismissed: dismissedIds.has(a.id),
      hasEnrichment: !!a.enrichment,
    }))
    .filter((a) => !isInScope(a))
    .slice(0, LAZY_ENRICH_MAX);
  if (candidates.length === 0) return;
  let remaining = candidates.length;
  setStatus(`Analyzing ${remaining} more…`);
  fetchEnrichments(candidates, (n) => {
    remaining -= n;
    if (window.__renderAll) window.__renderAll();
    if (remaining > 0) setStatus(`Analyzing ${remaining} more…`);
    else setStatus("");
  }).then((failed) => {
    if (failed) setStatus(enrichFailureMessage(failed), true);
  });
}

function isStale(a) {
  const due = dueDateObj(a);
  if (!due) return false;
  return daysUntil(due) < -STALE_DAYS;
}

function shouldDropEarly(a) {
  if (a.kind === "announcement") {
    const created = a.creationTime ? new Date(a.creationTime).getTime() : null;
    if (created && Date.now() - created > 2 * 86400000) return true;
    return false;
  }
  if (a.kind === "material") {
    const created = a.creationTime ? new Date(a.creationTime).getTime() : null;
    if (created && Date.now() - created > 14 * 86400000) return true;
    return false;
  }
  const due = dueDateObj(a);
  if (due) return daysUntil(due) < -STALE_DAYS;
  const updated = a.updateTime ? new Date(a.updateTime).getTime() : null;
  if (updated && Date.now() - updated > 30 * 86400000) return true;
  return false;
}

function renderFull(all) {
  const list = $("fullList");
  list.innerHTML = "";
  const pending = all.filter((a) => a.kind === "assignment" && !isStale(a) && (isPending(a) || displayPrefs.showSubmitted));
  if (pending.length === 0) {
    list.innerHTML = `<div class="empty">Nothing pending.</div>`;
    return;
  }
  const byCourse = new Map();
  pending.forEach((a) => {
    if (!byCourse.has(a.courseName)) byCourse.set(a.courseName, []);
    byCourse.get(a.courseName).push(a);
  });
  for (const [course, items] of byCourse) {
    const group = document.createElement("div");
    group.className = "course-group";
    const h = document.createElement("div");
    h.className = "day-label";
    h.textContent = course;
    group.appendChild(h);
    const sorted = currentSort === "default"
      ? [...items].sort((a, b) => (dueDateObj(a)?.getTime() ?? Infinity) - (dueDateObj(b)?.getTime() ?? Infinity))
      : applySort(items);
    sorted.forEach((a) => group.appendChild(assignmentCard(a)));
    list.appendChild(group);
  }
}

function materialDescriptor(m) {
  if (m.driveFile) {
    const df = m.driveFile.driveFile || m.driveFile;
    return { kind: "drive", id: df.id, title: df.title, link: df.alternateLink };
  }
  if (m.youtubeVideo) return { kind: "youtube", id: m.youtubeVideo.id, title: m.youtubeVideo.title, link: m.youtubeVideo.alternateLink };
  if (m.link) return { kind: "link", title: m.link.title || m.link.url, link: m.link.url };
  if (m.form) return { kind: "form", title: m.form.title, link: m.form.formUrl };
  return null;
}

function loadMaterialsFor(a) {
  return (a.materials || []).map(materialDescriptor).filter(Boolean).map((d) => ({ ...d, text: null }));
}

function renderMaterialsList(mats) {
  if (!mats.length) return "";
  const items = mats.map((m) => {
    const safeTitle = escapeHtml(m.title || "(untitled)");
    const safeLink = escapeHtml(m.link || "#");
    const tag = m.text ? "📄" : m.kind === "youtube" ? "▶" : m.kind === "form" ? "📝" : m.kind === "link" ? "🔗" : "📎";
    return `<a class="material-chip" href="${safeLink}" target="_blank" rel="noopener" title="${safeTitle}"><span class="chip-icon">${tag}</span><span class="chip-title">${safeTitle}</span></a>`;
  }).join("");
  return `<div class="materials-strip">${items}</div>`;
}

let markedLoadPromise = null;
function ensureMarked() {
  if (window.marked) return Promise.resolve();
  if (markedLoadPromise) return markedLoadPromise;
  markedLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load marked.min.js"));
    document.head.appendChild(s);
  });
  return markedLoadPromise;
}

/**
 * Open the assignment panel.
 *
 * Everything the panel needs to APPEAR happens synchronously, inside the click
 * that asked for it. Loading the saved conversation is a network round-trip and
 * is done afterwards.
 *
 * It used to be the other way round, and that one `await` before
 * `$("ai").hidden = false` caused both of the symptoms reported:
 *
 *   - The sheet's slide-up animation began in a promise continuation, long
 *     after the tap, so it read as "nothing, hitch, already open".
 *   - `$("aiInput").focus()` landed outside the user-gesture task, and mobile
 *     browsers will not raise the keyboard from there. On a cache HIT there was
 *     no await, focus stayed inside the gesture, and the keyboard appeared —
 *     which is why it happened on exactly every other open.
 *
 * The keyboard is now never raised on a touch device; see the focus call below.
 */
async function openAi(a) {
  activeAssignment = a;
  aiHistory = chatHistories.get(a.id) || [];
  activeMaterials = [];
  $("aiTitle").textContent = a.title || "Assignment";
  const due = dueDateObj(a);
  const dueTxt = due ? due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "No due date";
  activeMaterials = loadMaterialsFor(a);
  const panel = assignmentPanelModel({
    courseName: a.courseName,
    dueLabel: dueTxt,
    submitted: isSubmittedState(a.submission?.state),
    enrichment: a.enrichment,
    materials: activeMaterials,
    description: a.description,
    link: a.alternateLink ? withAuthUser(a.alternateLink) : "",
  });

  // Structure, not a <br>-joined string. The old block ran seven kinds of fact
  // together inside a 200px scroller its own content always overflowed, and
  // between it and the grounding box below there was 461px of furniture before
  // the conversation started — 465px of a 776px phone sheet, leaving 139px of
  // actual chat.
  const ctxParts = [];
  if (panel.facts.length || panel.link) {
    const chips = panel.facts.map((fact) =>
      `<span class="ai-fact"><span class="ai-fact-label">${escapeHtml(fact.label)}</span>${escapeHtml(fact.value)}</span>`).join("");
    const link = panel.link
      ? `<a href="${escapeHtml(panel.link)}" target="_blank" rel="noopener" class="classroom-link ai-fact-link">Classroom ↗</a>`
      : "";
    ctxParts.push(`<div class="ai-facts">${chips}${link}</div>`);
  }
  if (panel.summary) ctxParts.push(`<p class="ai-summary">${escapeHtml(panel.summary)}</p>`);
  if (panel.note) ctxParts.push(`<p class="ai-note">${escapeHtml(panel.note)}</p>`);
  if (panel.materialCount) ctxParts.push(renderMaterialsList(panel.materials));
  if (panel.hasDescription) {
    ctxParts.push(`<details class="original-desc"><summary>Original from Classroom</summary><div class="original-desc-body">${renderAssignmentDescription(a.description)}</div></details>`);
  }
  $("aiContext").innerHTML = ctxParts.join("");

  const tutorContext = plannerTutorContextModel({ ...a, materials: activeMaterials });
  const grounding = $("aiGroundingBadge");
  if (grounding) {
    grounding.hidden = false;
    // One quiet line. The label used to head a tinted box that restated the
    // panel title, the course and every attachment — directly beneath all
    // three. The full source list stays in the DOM for the copy button and for
    // screen readers; it just no longer costs 171px to say it twice.
    grounding.querySelector(".ai-grounding-label").textContent = groundingLineModel(panel);
    grounding.querySelector(".ai-grounding-summary").textContent = tutorContext.summary;
    grounding.querySelector(".ai-grounding-sources").textContent = `Sources: ${tutorContext.sources.join(" · ")}`;
  }
  renderLibraryStrip(a);
  renderChatHistory();
  $("aiInput").placeholder = a.kind === "material" ? "Ask about this material…" : "Ask about this assignment…";
  renderQuickPrompts(DEFAULT_QUICK_PROMPTS);

  // Visible now, in the same task as the tap, so the sheet animates from the
  // start rather than after a round-trip.
  $("ai").hidden = false;
  // Not on a touch device: raising the keyboard covers half the sheet before
  // the reader has seen any of it. A pointer user gets the caret for free.
  if (!prefersNoAutoFocus()) $("aiInput").focus();

  if (!window.marked) ensureMarked().then(() => renderChatHistory()).catch(() => {});

  // The saved conversation arrives afterwards. Guard on activeAssignment: the
  // panel may have been closed, or another assignment opened, while it loaded.
  if (!chatHistories.has(a.id)) {
    const remote = await loadChatHistory(a.id);
    chatHistories.set(a.id, Array.isArray(remote) ? remote : []);
  }
  if (activeAssignment?.id !== a.id) return;
  aiHistory = chatHistories.get(a.id);
  renderChatHistory();
  if (aiHistory.length >= 2) refreshSuggestions();
}

/**
 * True where focusing a text field would raise an on-screen keyboard.
 *
 * `pointer: coarse` with no hover is the honest test for a touch device; a
 * width query would also catch a small desktop window, where auto-focus is
 * harmless and useful.
 */
function prefersNoAutoFocus() {
  try {
    return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function closeAssignmentPanel() {
  const panel = $("ai");
  if (!panel || panel.hidden) return false;
  panel.hidden = true;
  // Leave nothing behind from a drag: the open animation is a CSS keyframe on
  // `transform`, and an inline one left over from a dismissal would win.
  panel.style.transform = "";
  panel.style.transition = "";
  activeAssignment = null;
  activeLibraryNotes = [];
  return true;
}

$("aiClose").addEventListener("click", closeAssignmentPanel);

// ---------------------------------------------------------------------------
// The bottom sheet's grab handle.
//
// It used to be `#ai::before` — a pseudo-element with `pointer-events: none`.
// It looked exactly like the thing you pull a sheet down by, and pulling it
// scrolled the list behind instead, because the touch never reached the sheet
// at all. An affordance that lies is worse than no affordance.
//
// The handle is a real button now: drag it to move the sheet, let go past a
// quarter of its height (or flick) to dismiss, tap it to close outright. It is
// display:none above 640px, where the panel is a side rail with nothing to pull.
// ---------------------------------------------------------------------------
(() => {
  const handle = $("aiSheetHandle");
  const panel = $("ai");
  if (!handle || !panel) return;

  const SETTLE_MS = 200;
  const SETTLE = `transform ${SETTLE_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`;
  let startY = null;
  let startedAt = 0;
  let height = 0;
  let travelled = 0;

  const settle = () => {
    panel.style.transition = "";
    panel.style.transform = "";
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    startY = event.clientY;
    startedAt = event.timeStamp;
    travelled = 0;
    height = panel.getBoundingClientRect().height;
    // While a finger is down the transform IS the finger; easing it would lag.
    panel.style.transition = "none";
    try { handle.setPointerCapture(event.pointerId); } catch { /* older engines */ }
  });

  handle.addEventListener("pointermove", (event) => {
    if (startY === null) return;
    const { offset } = sheetDragModel({ startY, currentY: event.clientY, height });
    travelled = offset;
    panel.style.transform = offset ? `translateY(${offset}px)` : "";
  });

  const release = (event) => {
    if (startY === null) return;
    const drag = sheetDragModel({
      startY,
      currentY: event.clientY ?? startY,
      height,
      elapsedMs: event.timeStamp - startedAt,
    });
    startY = null;
    panel.style.transition = SETTLE;
    if (!drag.dismiss) {
      panel.style.transform = "";
      setTimeout(settle, SETTLE_MS);
      return;
    }
    // Finish the throw before the sheet disappears, rather than blinking out
    // from wherever the finger happened to leave it.
    panel.style.transform = "translateY(100%)";
    setTimeout(() => { settle(); closeAssignmentPanel(); }, SETTLE_MS);
  };
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);

  // A tap is the gesture people try first. Only a tap: a drag that ended short
  // of the threshold has already been answered by springing back.
  handle.addEventListener("click", () => {
    if (travelled <= 6) closeAssignmentPanel();
    travelled = 0;
  });
})();

// ---------------------------------------------------------------------------
// How much of the bottom edge the browser is sitting on.
//
// On a phone the address/search bar is at the BOTTOM of the screen, and the
// on-screen keyboard covers the same edge. Neither is part of the visual
// viewport, but `position: fixed; bottom: 0` measures against the LAYOUT
// viewport — so the sheet's last row (Send, Clear, the quick prompts) rendered
// underneath the browser's own bar and could not be tapped. `visualViewport` is
// the only thing that reports the difference; the sheet pads itself by it.
// ---------------------------------------------------------------------------
(() => {
  const vv = window.visualViewport;
  let queued = false;
  const sync = () => {
    const inset = viewportBottomInset({
      innerHeight: window.innerHeight,
      visualHeight: vv?.height ?? window.innerHeight,
      visualOffsetTop: vv?.offsetTop ?? 0,
    });
    document.documentElement.style.setProperty("--viewport-bottom-inset", `${inset}px`);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sync(); });
  };
  sync();
  window.addEventListener("resize", schedule, { passive: true });
  // visualViewport `scroll` fires as the bar collapses and expands, which is
  // exactly when the inset changes; `resize` alone misses it.
  vv?.addEventListener("resize", schedule, { passive: true });
  vv?.addEventListener("scroll", schedule, { passive: true });
})();

// Escape closes the panel too. It is a full-screen sheet on a phone and a rail
// that covers the header on a desktop, so "how do I get out of this" needs more
// than one answer — and typing Escape in the question box should not send it.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const panel = $("ai");
  if (!panel || panel.hidden) return;
  const modalOpen = [...document.querySelectorAll(".modal")].some((m) => !m.hidden);
  if (modalOpen) return; // the topmost surface handles its own Escape
  if (closeAssignmentPanel()) e.stopPropagation();
});

$("aiGroundingCopy")?.addEventListener("click", async () => {
  if (!activeAssignment || !navigator.clipboard?.writeText) return;
  const button = $("aiGroundingCopy");
  const status = $("aiGroundingCopyStatus");
  const announce = (state) => {
    const model = plannerTutorCopyStatusModel(state);
    button.textContent = model.label;
    if (status) status.textContent = model.announcement;
  };
  try {
    await navigator.clipboard.writeText(plannerTutorSourcesText({ ...activeAssignment, materials: activeMaterials }));
    announce("success");
    setTimeout(() => announce("idle"), 1200);
  } catch {
    announce("error");
    setTimeout(() => announce("idle"), 1600);
  }
});

$("aiClearBtn").addEventListener("click", () => {
  if (!activeAssignment) return;
  aiHistory = [];
  chatHistories.set(activeAssignment.id, aiHistory);
  renderChatHistory();
  renderQuickPrompts(DEFAULT_QUICK_PROMPTS);
  persistChat();
});

$("aiForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("aiInput").value.trim();
  if (!text) return;
  $("aiInput").value = "";
  sendAi(text);
});


function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderMarkdown(text) {
  if (window.marked) {
    return window.marked.parse(text, { breaks: true, gfm: true });
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function lastUserMsgIndex() {
  for (let i = aiHistory.length - 1; i >= 0; i--) {
    if (aiHistory[i].role === "user") return i;
  }
  return -1;
}

function addMsg(role, text, index) {
  const el = document.createElement("div");
  el.className = `ai-msg ${role}`;
  el.dataset.index = index ?? "";

  const content = document.createElement("div");
  content.className = "msg-content";
  if (role === "assistant") {
    content.innerHTML = renderMarkdown(text);
  } else {
    content.textContent = text;
  }
  el.appendChild(content);

  if (typeof index === "number" && role === "user") {
    const isLast = index === lastUserMsgIndex();
    const actions = document.createElement("div");
    actions.className = "msg-actions";

    if (isLast) {
      const editBtn = document.createElement("button");
      editBtn.className = "msg-action";
      editBtn.title = "Edit and resubmit";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", () => editMessage(index));
      actions.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "msg-action";
      delBtn.title = "Delete";
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", () => deleteMessage(index));
      actions.appendChild(delBtn);
    } else {
      const rewindBtn = document.createElement("button");
      rewindBtn.className = "msg-action";
      rewindBtn.title = "Rewind to this message";
      rewindBtn.textContent = "↶";
      rewindBtn.addEventListener("click", () => rewindToMessage(index));
      actions.appendChild(rewindBtn);
    }
    el.appendChild(actions);
  }

  $("aiMessages").appendChild(el);
  $("aiMessages").scrollTop = $("aiMessages").scrollHeight;
  return el;
}

function renderChatHistory() {
  $("aiMessages").innerHTML = "";
  for (let i = 0; i < aiHistory.length; i++) {
    addMsg(aiHistory[i].role, aiHistory[i].content, i);
  }
}

function persistChat() {
  if (activeAssignment) saveChatHistory(activeAssignment.id, aiHistory);
}

function deleteMessage(index) {
  const drop = aiHistory[index + 1]?.role === "assistant" ? 2 : 1;
  aiHistory.splice(index, drop);
  renderChatHistory();
  persistChat();
}

function rewindToMessage(index) {
  aiHistory = aiHistory.slice(0, index);
  if (activeAssignment) chatHistories.set(activeAssignment.id, aiHistory);
  renderChatHistory();
  persistChat();
}

function editMessage(index) {
  const original = aiHistory[index]?.content || "";
  const edited = window.prompt("Edit message:", original);
  if (edited === null) return;
  const trimmed = edited.trim();
  if (!trimmed) return;
  aiHistory = aiHistory.slice(0, index);
  if (activeAssignment) chatHistories.set(activeAssignment.id, aiHistory);
  renderChatHistory();
  sendAi(trimmed);
}

async function sendAi(userText) {
  if (!activeAssignment) return;
  aiHistory.push({ role: "user", content: userText });
  addMsg("user", userText, aiHistory.length - 1);
  const thinking = addMsg("assistant", "…");

  const a = activeAssignment;

  const materialsContext = activeMaterials.map((m) => {
    const linkPart = m.link ? ` URL: ${m.link}` : "";
    if (m.text) return `[${m.kind}] Title: ${m.title}${linkPart}\nContent:\n${m.text}`;
    return `[${m.kind}] Title: ${m.title}${linkPart}`;
  }).join("\n\n---\n\n");

  const assignmentNote = {
    t: a.title || "Assignment",
    course: a.courseName || "",
    topic: a.enrichment?.topic || "Assignment",
    s: a.enrichment?.oneLineSummary || "",
    x: [
      a.description ? `Description: ${a.description}` : "",
      materialsContext ? `Attached materials:\n${materialsContext}` : "",
      a.alternateLink ? `Classroom link: ${withAuthUser(a.alternateLink)}` : "",
    ].filter(Boolean).join("\n\n"),
  };
  const tutorNotes = [assignmentNote, ...activeLibraryNotes.slice(0, 5).map((n) => ({
    t: n.t, course: n.course, y: n.y, topic: n.topic, s: n.s, x: n.x,
  }))];

  try {
    const r = await fetch("/api/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ messages: aiHistory, notes: tutorNotes }),
    });
    if (r.status === 429) {
      const data = await r.json().catch(() => ({}));
      thinking.className = "ai-msg error";
      thinking.textContent = data.message || `Daily AI limit reached (${data.limit || ""}).`;
      aiHistory.pop();
      return;
    }
    if (!r.ok || !r.body) throw new Error(`AI error ${r.status}: ${await r.text().catch(() => "")}`);

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    thinking.innerHTML = "";

    const flush = () => {
      thinking.innerHTML = renderMarkdown(accumulated);
      $("aiMessages").scrollTop = $("aiMessages").scrollHeight;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop();
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            accumulated += delta;
            flush();
          }
        } catch {}
      }
    }

    if (!accumulated) {
      thinking.textContent = "(no response)";
    } else {
      aiHistory.push({ role: "assistant", content: accumulated });
      renderChatHistory();
      saveChatHistory(activeAssignment.id, aiHistory);
      refreshSuggestions();
    }
  } catch (e) {
    thinking.className = "ai-msg error";
    thinking.textContent = e.message;
  }
}

const DEFAULT_QUICK_PROMPTS = [
  { label: "Study guide", prompt: "Make me a structured study guide for this assignment. Break the topics into sections — one ## heading per topic. Under each: brief explanation, key terms in bold, a short worked example, and a self-check question. Reference attached materials by name where relevant." },
  { label: "Quiz me", prompt: "Quiz me on this assignment. Ask one question at a time, wait for my answer, then give brief feedback and the next question. Cover all the key topics across 5-7 questions, drawing on the attached materials." },
  { label: "Key points", prompt: "Give me the key points I need to know from this assignment and any attached materials. Be concrete: list the main concepts, formulas, dates, names, or rules. Use bullet points grouped by topic. Reference materials by name when relevant." },
];

function renderQuickPrompts(items) {
  const container = document.querySelector(".ai-quick");
  if (!container) return;
  container.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.textContent = item.label;
    btn.dataset.prompt = item.prompt;
    btn.addEventListener("click", () => sendAi(btn.dataset.prompt));
    container.appendChild(btn);
  }
}

async function refreshSuggestions() {
  if (!activeAssignment || aiHistory.length < 2) {
    renderQuickPrompts(DEFAULT_QUICK_PROMPTS);
    return;
  }
  try {
    const r = await fetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ messages: aiHistory }),
    });
    if (!r.ok) return;
    const data = await r.json();
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (suggestions.length === 0) return;
    renderQuickPrompts(suggestions.map((s) => ({ label: s.length > 32 ? s.slice(0, 30) + "…" : s, prompt: s })));
  } catch {}
}

// ---------------------------------------------------------------------------
// Sticky-header height, published as --header-h.
//
// The header is `position: sticky`, so anything else that sticks to the top of
// the viewport (the Curriculum matrix's year row) has to start below it. Its
// height is not a constant: the switcher takes its own row under 640px, and a
// long title can wrap. Measured rather than guessed, and kept up to date.
// ---------------------------------------------------------------------------
function trackHeaderHeight() {
  const header = document.querySelector("header");
  if (!header) return;
  const apply = () => {
    const height = Math.round(header.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty("--header-h", `${height}px`);
  };
  apply();
  if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(header);
  else window.addEventListener("resize", apply);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", trackHeaderHeight);
} else {
  trackHeaderHeight();
}

// ---------------------------------------------------------------------------
// Coming back to the page.
//
// A phone does not reload when you switch apps and return: it freezes the page
// and restores it. No boot code runs, no refresh timer fired while it was
// frozen, and the access token may have expired in the meantime — so the first
// thing the restored page does is fail. Re-check the session on the way back in
// instead of finding out through a 401.
// ---------------------------------------------------------------------------
let sessionRecheckInFlight = null;

async function recheckSessionOnResume(persisted) {
  const stored = await loadStoredToken().catch(() => null);
  const decision = sessionResumeModel({
    persisted,
    visible: document.visibilityState !== "hidden",
    expiresAt: stored?.expiresAt ?? 0,
  });
  if (!decision.recheck) return;
  if (sessionRecheckInFlight) return sessionRecheckInFlight;
  sessionRecheckInFlight = (async () => {
    try {
      // Nothing to restore for a user who was never signed in here.
      if (!hasServerSession() && !loadUserHint() && !stored?.token) return;
      const token = await recoverAccessToken();
      // Only re-render when this actually changed something. A restored page
      // whose token was still good must not be torn down and rebuilt.
      if (token && $("welcome") && !$("welcome").hidden) onSignedIn();
    } finally {
      sessionRecheckInFlight = null;
    }
  })();
  return sessionRecheckInFlight;
}

window.addEventListener("pageshow", (e) => { void recheckSessionOnResume(!!e.persisted); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void recheckSessionOnResume(false);
});
