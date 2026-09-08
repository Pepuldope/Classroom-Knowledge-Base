// kb.js — private Knowledge Base view + AI tutor.
//
// Self-contained module. It does NOT reach into app.js internals; it only
// reuses the already-initialized Google token client (window.__cwaTokenClient)
// and the shared CLIENT_ID. The Planner and Archive views keep working
// exactly as before.
//
// Public surface used:
//   - accessToken (app.js global) — current Google OAuth access token
//   - window.__cwaTokenClient — the google.accounts.oauth2 token client
//   - getOauthConfig() / storeUserSub() — from app.js (auth state)
//
//   POST /api/tutor        { messages:[...], notes:[...] } (streaming SSE)
// Classroom ingestion and KB retrieval are browser-local; the tutor is the only
// KB request that leaves the browser, and it receives only bounded retrieved notes.

import { highlightSnippet } from "./kb-highlight.js";
import { renderLightMarkdown } from "./archive.js";
import { studyTabModel, studyTabForAction, STUDY_TABS } from "./study-tabs.js";
import { renderCurriculum, curriculumControlsModel } from "./kb-curriculum.js";
import { kbAutoSyncModel, kbSyncStatusModel } from "./kb-autosync.js";
import { loadKbBundle, saveMergedKbBundle, removeKbBundle, browseKbBundle, browseYearFacet, browseFamilyFacet, browseTopicFacet, loadKbBuildCheckpoint, saveKbBuildCheckpoint, removeKbBuildCheckpoint } from "./kb-local.js";
import { searchNotes, makeSortFn, deriveFamily, suggestCorrection, relatedNotesPreview, relatedTokenCacheStats, recordRelatedPreviewTiming } from "./kb-client-search.js";
import { studyStreakModel, recordStudyActivity } from "./study-streak.js";
import { recordNoteProgress, studyProgressModel, studyProgressCopy, migrateNoteProgress } from "./study-progress.js";
import { buildArchiveFromClassroom } from "./archive-builder.js";
import { kbBundleFromClassroomArchive } from "./kb-client-build.js";
import { buildReviewDigest } from "./review-digest.js";
import { kbBuildProgressStatusModel, kbBuildCheckpointModel, kbBuildResumeSummaryModel } from "./kb-local-status.js";
import { buildTutorRetrievedNotes, tutorRequestNotesModel } from "./kb-tutor-context.js";
import { relatedPreviewAnnouncement } from "./kb-related-status.js";
import { classroomAuthRecoveryModel } from "./auth-view.js";

const $ = (id) => document.getElementById(id);
export const INTERACTIVE_OAUTH_PROMPT = "select_account";
export { highlightSnippet, bundleToMarkdown, bundleToCsv };

/** Return the next result-card index for keyboard navigation, or null when unused. */
export function kbResultNavigationIndex(current, key, count) {
  if (!Number.isInteger(count) || count < 1) return null;
  const forward = key === "ArrowDown" || key === "j";
  const backward = key === "ArrowUp" || key === "k";
  if (!forward && !backward) return null;
  const index = Number.isInteger(current) ? current : -1;
  if (index < 0) return forward ? 0 : count - 1;
  const delta = forward ? 1 : -1;
  return (index + delta + count) % count;
}

// ---------------------------------------------------------------------------
// Pure filter model (no DOM): turn the raw facet lists from local retrieval
// into a complete, untruncated list of courses + years with the active
// selection passed through. The UI renders from this so EVERY course is
// reachable as a filter (owner request #2) — no silent top-N truncation.
// ---------------------------------------------------------------------------
export function kbFilterModel(filters, active = {}) {
  const courses = Array.isArray(filters?.courses) ? filters.courses : [];
  const years = Array.isArray(filters?.years) ? filters.years : [];
  const kinds = Array.isArray(filters?.kinds) ? filters.kinds : [];
  const families = Array.isArray(filters?.families) ? filters.families : [];
  return {
    courses,
    years,
    kinds,
    families,
    activeCourse: active.course || "",
    activeYear: active.year || "",
    activeKind: active.kind || "",
    activeFamily: active.family || "",
    sort: active.sort || "relevance",
  };
}

/** Search a cached private bundle without a network round-trip. */
export function buildLocalSearchResponse(bundle, query, {
  course = "", courses = [], year = "", kind = "", family = "", sort = "relevance", limit = 8,
} = {}) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  // Reuse the bundle's own array when every note already carries a family —
  // mergeBundles stamps one on ingest, so this is the normal case. Rebuilding
  // it per call allocated a fresh array on every keystroke and, worse, defeated
  // the search index cache, which is keyed on the array identity.
  const needsFamilies = notes.some((note) => !note?.family);
  const withFamilies = needsFamilies
    ? notes.map((note) => note?.family ? note : ({ ...note, family: deriveFamily(note?.course) || "" }))
    : notes;
  const scopedCourses = new Set((Array.isArray(courses) ? courses : [])
    .map((value) => String(value || "").trim()).filter(Boolean));
  const isFiltering = scopedCourses.size > 0 || !!course || !!year || !!kind || !!family;
  const filtered = isFiltering
    ? withFamilies
      .map((note, index) => ({ note, index }))
      .filter(({ note }) =>
        (!scopedCourses.size || scopedCourses.has(note.course || "")) &&
        (!course || (note.course || "") === course) &&
        (!year || (note.y || "") === year) &&
        (!kind || (note.kind || "") === kind) &&
        (!family || (note.family || "") === family)
      )
    : null;
  // Unfiltered searches pass the same array object every time, so the cached
  // index is reused instead of rebuilt. `indexMap` is only needed to map
  // positions back through a filter.
  const filteredNotes = filtered ? filtered.map(({ note }) => note) : withFamilies;
  const indexMap = filtered ? filtered.map(({ index }) => index) : null;
  const collect = (field) => [...new Set(withFamilies.map((note) => note?.[field]).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  const results = searchNotes(filteredNotes, query, { limit, sortFn: makeSortFn(sort), indexMap });
  return {
    meta: {
      noteCount: notes.length,
      years: Array.isArray(bundle?.years) ? bundle.years : collect("y"),
      courses: collect("course").length,
      generatedAt: bundle?.generatedAt || null,
      updatedAt: bundle?.generatedAt || null,
    },
    results,
    didYouMean: suggestCorrection(filteredNotes, query, { hasResults: results.length > 0 }),
    filteredCount: filtered ? filtered.length : withFamilies.length,
    filters: {
      courses: collect("course"),
      years: collect("y"),
      kinds: collect("kind"),
      families: collect("family"),
    },
  };
}

/**
 * Which Classroom courses the corpus already knows about.
 *
 * Both the notes AND the bundle's own `courses` list, because a course that has
 * nothing posted in it yet produces no notes at all. Reading only the notes
 * meant such a course was "new" forever: the banner offered "Update now", the
 * rebuild correctly found nothing to add, and the banner came straight back.
 * Three of the owner's real courses are in that state, one of them current.
 */
export function knownCourseNames(bundle) {
  const names = new Set();
  for (const note of Array.isArray(bundle?.notes) ? bundle.notes : []) {
    const name = String(note?.course || "").trim();
    if (name) names.add(name);
  }
  for (const course of Array.isArray(bundle?.courses) ? bundle.courses : []) {
    // `courses` entries are objects, but a legacy bundle stored bare strings.
    const name = String((typeof course === "string" ? course : course?.name) || "").trim();
    if (name) names.add(name);
  }
  return names;
}

/**
 * The banner's sentence.
 *
 * It names the courses. "1 new course found in Google Classroom" said nothing
 * about WHICH course, which is why a course that could never be satisfied went
 * unnoticed as a permanent notice rather than being obviously one specific
 * empty class. Bounded so a first-ever build does not print forty names.
 */
export function classroomChangesMessage(newCourses) {
  const names = (Array.isArray(newCourses) ? newCourses : [])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  if (names.length === 0) return "";
  const count = `${names.length} new course${names.length === 1 ? "" : "s"} in Google Classroom`;
  if (names.length > 3) return `${count}: ${names.slice(0, 3).join(", ")} and ${names.length - 3} more.`;
  return `${count}: ${names.join(", ")}.`;
}

export function detectClassroomChanges(bundle, courses) {
  const cachedCourses = knownCourseNames(bundle);
  const newCourses = [...new Set((Array.isArray(courses) ? courses : [])
    .map((course) => String(course?.name || "").trim())
    .filter((name) => name && !cachedCourses.has(name)))];
  return { newCourses, hasChanges: newCourses.length > 0 };
}

export function localNoteFromBundle(bundle, index) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  return Number.isInteger(index) && index >= 0 && index < notes.length ? notes[index] || null : null;
}

export function localRelatedFromBundle(bundle, index, opts = {}) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  if (!localNoteFromBundle(bundle, index)) return [];
  const started = typeof performance !== "undefined" ? performance.now() : 0;
  const related = relatedNotesPreview(notes, index, opts);
  if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    recordRelatedPreviewTiming(elapsedMs);
    console.debug("[KB perf] related-preview", { elapsedMs, cache: relatedTokenCacheStats() });
  }
  return related;
}

const KB_SETTINGS_KEY = "cwa_kb_settings";
const KB_SEARCH_STATE_KEY = "cwa_kb_search_state";
const KB_BROWSE_STATE_KEY = "cwa_kb_browse_state";
const KB_COPY_HISTORY_KEY = "cwa_kb_copy_history";
const TUTOR_THREAD_TITLE_KEY = "cwa_tutor_thread_title";
const TUTOR_THREAD_ARCHIVE_KEY = "cwa_tutor_thread_archive";
let latestCopySearchContextText = "";

function announceCopyStatus(element, message) {
  if (!element) return;
  const next = (Number(element.dataset.announcement) || 0) + 1;
  element.textContent = "";
  element.dataset.announcement = String(next);
  element.textContent = message;
}
const STUDY_LIST_KEY = "cwa_tutor_study_list";
const STUDY_ACTIVITY_KEY = "cwa_kb_study_activity";
const STUDY_PROGRESS_KEY = "cwa_kb_note_progress";
const STUDY_MODE_PROGRESS_KEY = "cwa_kb_study_mode_progress";
const KB_SEARCH_SORTS = new Set(["relevance", "recency", "course", "title"]);
const KB_PINNED_COURSES_KEY = "cwa_kb_pinned_courses";
const KB_PINNED_NOTES_KEY = "cwa_kb_pinned_notes";

/** Normalize the last-used local KB filter state; unknown values never persist. */
export function kbSearchStateModel(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const text = (key) => typeof input[key] === "string" ? input[key].trim() : "";
  return {
    course: text("course"),
    year: text("year"),
    kind: text("kind"),
    family: text("family"),
    sort: KB_SEARCH_SORTS.has(input.sort) ? input.sort : "relevance",
  };
}

export const KB_BROWSE_GRID_SORTS = ["notes", "alpha", "recent"];
export const KB_BROWSE_NOTE_SORTS = ["recency", "title", "course"];

/**
 * Normalize the browser-local Browse selection.
 *
 * `year` and `family` are corpus-wide and deliberately survive stepping into
 * and back out of a course: the year control used to be created per-course and
 * thrown away on the way back to the grid, which is why filtering by year never
 * felt like it did anything. `q`, `topic`, `sort` and `recent` are scoped to the
 * view that owns them.
 */
export function kbBrowseStateModel(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const text = (key) => typeof input[key] === "string" ? input[key].trim() : "";
  const gridSort = KB_BROWSE_GRID_SORTS.includes(input.gridSort) ? input.gridSort : "notes";
  const noteSort = KB_BROWSE_NOTE_SORTS.includes(input.noteSort) ? input.noteSort : "recency";
  return {
    course: text("course"),
    year: text("year"),
    family: text("family"),
    topic: text("topic"),
    q: text("q"),
    gridSort,
    noteSort,
    recent: input.recent === true,
  };
}

/** True when nothing is filtering or re-sorting the current Browse view. */
export function kbBrowseIsDefault(state, { inCourse = false } = {}) {
  const s = kbBrowseStateModel(state);
  if (s.year || s.q) return false;
  return inCourse ? !s.topic && !s.recent && s.noteSort === "recency" : !s.family && s.gridSort === "notes";
}

function loadKbBrowseState() {
  try {
    return kbBrowseStateModel(JSON.parse(localStorage.getItem(KB_BROWSE_STATE_KEY) || "null"));
  } catch { return kbBrowseStateModel(); }
}

function saveKbBrowseState(value) {
  const state = kbBrowseStateModel(value);
  try { localStorage.setItem(KB_BROWSE_STATE_KEY, JSON.stringify(state)); } catch {}
  return state;
}

export function initialKbSearchState(saved, settings = {}) {
  const hasSavedState = saved && typeof saved === "object" && Object.keys(saved).length > 0;
  if (hasSavedState) return kbSearchStateModel(saved);
  const preferredSort = KB_SEARCH_SORTS.has(settings?.defaultSort) ? settings.defaultSort : "relevance";
  return kbSearchStateModel({ sort: preferredSort });
}

/** Resolve the Settings default scope without overriding an explicit course filter. */
export function kbScopeFilters(settings = {}, active = {}, { currentCourse = "", pinnedCourses = [] } = {}) {
  if (active?.course) return { courses: [String(active.course)] };
  const scope = settings?.defaultScope;
  if (scope === "current") {
    const course = String(currentCourse || "").trim();
    return { courses: course ? [course] : [] };
  }
  if (scope === "pinned") {
    const courses = [...new Set((Array.isArray(pinnedCourses) ? pinnedCourses : [])
      .map((course) => String(course || "").trim()).filter(Boolean))];
    return { courses };
  }
  return { courses: [] };
}

/** Normalize the browser-local pinned course list used by the default scope. */
export function kbPinnedCoursesModel(value = []) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((course) => String(course || "").trim()).filter(Boolean))];
}

/** Keep the browse default useful without overriding an explicit query sort. */
export function kbSortForQuery(query, sort, { explicit = false } = {}) {
  const selected = KB_SEARCH_SORTS.has(sort) ? sort : "relevance";
  return String(query || "").trim() && selected === "recency" && !explicit ? "relevance" : selected;
}

export function loadKbSearchState() {
  try {
    const raw = JSON.parse(localStorage.getItem(KB_SEARCH_STATE_KEY) || "null");
    return initialKbSearchState(raw, loadKbSettings());
  } catch { return initialKbSearchState(null, loadKbSettings()); }
}

export function saveKbSearchState(value) {
  const state = kbSearchStateModel(value);
  try { localStorage.setItem(KB_SEARCH_STATE_KEY, JSON.stringify(state)); } catch {}
  return state;
}

export function loadKbPinnedCourses() {
  try {
    return kbPinnedCoursesModel(JSON.parse(localStorage.getItem(KB_PINNED_COURSES_KEY) || "[]"));
  } catch { return []; }
}

export function saveKbPinnedCourses(value) {
  const courses = kbPinnedCoursesModel(value);
  try { localStorage.setItem(KB_PINNED_COURSES_KEY, JSON.stringify(courses)); } catch {}
  return courses;
}

/** Normalize the small local pin records; note bodies and source paths never persist. */
export function pinnedNotesModel(value = []) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const id = typeof item?.id === "string" ? item.id.trim().slice(0, 240) : "";
    const title = typeof item?.title === "string" ? item.title.trim().slice(0, 240) : "";
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, title });
  }
  return result.slice(0, 100);
}

export function togglePinnedNote(current, note) {
  const list = pinnedNotesModel(current);
  const record = pinnedNoteRecord(note);
  if (!record) return list;
  if (list.some((item) => item.id === record.id)) return list.filter((item) => item.id !== record.id);
  return pinnedNotesModel([...list, record]);
}

function pinnedNoteRecord(note) {
  const title = typeof note?.t === "string" ? note.t.trim() : typeof note?.title === "string" ? note.title.trim() : "";
  const id = typeof note?.id === "string" ? note.id.trim() : "";
  const fallback = [note?.course, note?.y, title, note?.topic].map((value) => String(value || "").trim()).join("|");
  const stableId = id || fallback;
  return stableId && title ? { id: stableId.slice(0, 240), title: title.slice(0, 240) } : null;
}

function loadPinnedNotes() {
  try { return pinnedNotesModel(JSON.parse(localStorage.getItem(KB_PINNED_NOTES_KEY) || "[]")); } catch { return []; }
}

function savePinnedNotes(value) {
  const notes = pinnedNotesModel(value);
  try { localStorage.setItem(KB_PINNED_NOTES_KEY, JSON.stringify(notes)); } catch {}
  return notes;
}

function notePinId(note) {
  return pinnedNoteRecord(note)?.id || "";
}

function renderNotePinButton(note) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kb-note-pin";
  const update = () => {
    const pinned = loadPinnedNotes().some((item) => item.id === notePinId(note));
    button.classList.toggle("pinned", pinned);
    button.textContent = pinned ? "★ Pinned" : "☆ Pin note";
    button.title = pinned ? "Unpin note" : "Pin note locally";
    button.setAttribute("aria-pressed", String(pinned));
  };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    savePinnedNotes(togglePinnedNote(loadPinnedNotes(), note));
    update();
  });
  update();
  return button;
}

/** Normalize locally saved tutor answers; malformed entries never reach the UI. */
export function studyListModel(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item.id === "string" && item.id.trim() && typeof item.text === "string" && item.text.trim())
    .map((item) => ({ id: item.id.trim(), text: item.text.trim(), savedAt: Number.isFinite(Number(item.savedAt)) ? Number(item.savedAt) : 0 }));
}

function studyAnswerId(text) {
  return String(text || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

export function addStudyAnswer(value, text, savedAt = Date.now()) {
  const clean = String(text || "").trim();
  if (!clean) return studyListModel(value);
  const id = studyAnswerId(clean);
  const list = studyListModel(value);
  if (!id || list.some((item) => item.id === id)) return list;
  return [...list, { id, text: clean, savedAt: Number(savedAt) || 0 }];
}

export function removeStudyAnswer(value, id) {
  return studyListModel(value).filter((item) => item.id !== String(id || "").trim());
}

function loadStudyList() {
  try { return studyListModel(JSON.parse(localStorage.getItem(STUDY_LIST_KEY) || "[]")); } catch { return []; }
}

function saveStudyList(value) {
  const list = studyListModel(value);
  try { localStorage.setItem(STUDY_LIST_KEY, JSON.stringify(list)); } catch {}
  return list;
}

function loadStudyModeProgress(answerId, total) {
  try {
    const saved = JSON.parse(localStorage.getItem(STUDY_MODE_PROGRESS_KEY) || "{}");
    return studyModeProgressModel(saved?.[answerId], total);
  } catch {
    return studyModeProgressModel([], total);
  }
}

function saveStudyModeProgress(answerId, completed) {
  try {
    const saved = JSON.parse(localStorage.getItem(STUDY_MODE_PROGRESS_KEY) || "{}");
    const next = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    next[answerId] = completed;
    localStorage.setItem(STUDY_MODE_PROGRESS_KEY, JSON.stringify(next));
  } catch {}
}

const DEFAULT_KB_SETTINGS = Object.freeze({
  tutorEnabled: true,
  tutorEffort: "tutor",
  defaultScope: "all",
  defaultSort: "recency",
  relatedCount: 3,
  density: "comfortable",
  copyFormat: "lines",
  autoBuild: false,
  speechRate: 1,
});

/** Normalize browser-local KB controls; never sends these preferences to a server. */
export function kbSettingsModel(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const efforts = new Set(["quick", "tutor", "hard"]);
  const scopes = new Set(["all", "current", "pinned"]);
  const sorts = new Set(["relevance", "recency", "course", "title"]);
  const speechRate = Number(input.speechRate);
  const relatedCount = Number(input.relatedCount);
  return {
    tutorEnabled: input.tutorEnabled !== false,
    tutorEffort: efforts.has(input.tutorEffort) ? input.tutorEffort : DEFAULT_KB_SETTINGS.tutorEffort,
    defaultScope: scopes.has(input.defaultScope) ? input.defaultScope : DEFAULT_KB_SETTINGS.defaultScope,
    defaultSort: sorts.has(input.defaultSort) ? input.defaultSort : DEFAULT_KB_SETTINGS.defaultSort,
    relatedCount: Number.isFinite(relatedCount) ? Math.min(8, Math.max(1, Math.round(relatedCount))) : DEFAULT_KB_SETTINGS.relatedCount,
    density: input.density === "compact" ? "compact" : DEFAULT_KB_SETTINGS.density,
    copyFormat: input.copyFormat === "compact" ? "compact" : DEFAULT_KB_SETTINGS.copyFormat,
    autoBuild: input.autoBuild === true,
    speechRate: Number.isFinite(speechRate) ? Math.min(2, Math.max(0.5, speechRate)) : DEFAULT_KB_SETTINGS.speechRate,
  };
}

export function kbDensityClass(value = {}) {
  return kbSettingsModel(value).density === "compact" ? "kb-density-compact" : "kb-density-comfortable";
}

export function applyKbDensity(value = loadKbSettings()) {
  const view = $("kbView");
  if (!view) return;
  view.classList.remove("kb-density-compact", "kb-density-comfortable");
  view.classList.add(kbDensityClass(value));
}

export function relatedNotesLimit(value = {}) {
  return kbSettingsModel(value).relatedCount;
}

export function loadKbSettings() {
  try { return kbSettingsModel(JSON.parse(localStorage.getItem(KB_SETTINGS_KEY) || "{}")); }
  catch { return kbSettingsModel(); }
}

export function saveKbSettings(value) {
  const settings = kbSettingsModel(value);
  try { localStorage.setItem(KB_SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  return settings;
}

function todayIso() { return new Date().toISOString().slice(0, 10); }
function loadStudyActivity() {
  try { return JSON.parse(localStorage.getItem(STUDY_ACTIVITY_KEY) || "[]"); } catch { return []; }
}
function renderStudyStreak(activity) {
  const card = $("kbStudyStreak");
  if (!card) return;
  const streak = studyStreakModel(activity, todayIso());
  card.innerHTML = `<strong>🔥 ${streak.current} day${streak.current === 1 ? "" : "s"}</strong>` +
    `<span>${streak.activeToday ? "Nice work — your streak is active today." : "Search or open a note to start your streak."}</span>`;
  card.classList.toggle("is-active", streak.activeToday);
}
function markStudyActivity() {
  const updated = recordStudyActivity(loadStudyActivity(), todayIso());
  try { localStorage.setItem(STUDY_ACTIVITY_KEY, JSON.stringify(updated)); } catch {}
  renderStudyStreak(updated);
}
function loadStudyProgress() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(STUDY_PROGRESS_KEY) || "{}"); } catch { return {}; }
  const notes = Array.isArray(localKbBundle?.notes) ? localKbBundle.notes : [];
  // Nothing to migrate against until the corpus is loaded; returning the record
  // untouched is safer than pruning every entry as "gone".
  if (notes.length === 0) return raw && typeof raw === "object" ? raw : {};
  const migrated = migrateNoteProgress(raw, notes);
  // Write back only on an actual change, so a normal load does no storage work.
  const before = JSON.stringify(raw);
  const after = JSON.stringify(migrated);
  if (before !== after) {
    try { localStorage.setItem(STUDY_PROGRESS_KEY, after); } catch { /* private mode */ }
  }
  return migrated;
}
function renderStudyProgress(progress = loadStudyProgress()) {
  const card = $("kbStudyProgress");
  if (!card) return;
  const summary = studyProgressModel(progress, localKbBundle?.notes?.length || 0);
  const copy = studyProgressCopy(summary);
  card.innerHTML = `<strong>${copy.headline}</strong>` +
    `<span>${copy.detail}</span>`;
  card.setAttribute("aria-label", copy.detail);
}
function renderReviewDigest(progress = loadStudyProgress()) {
  const card = $("kbReviewDigest");
  const notes = Array.isArray(localKbBundle?.notes) ? localKbBundle.notes : [];
  if (!card || !notes.length) return;
  const digest = buildReviewDigest(notes, progress, 3);
  card.replaceChildren();
  const heading = document.createElement("h3");
  heading.id = "kbReviewDigestTitle";
  heading.textContent = digest.title;
  const detail = document.createElement("p");
  detail.className = "kb-review-detail";
  detail.textContent = digest.detail;
  const list = document.createElement("div");
  list.className = "kb-review-list";
  for (const item of digest.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kb-review-item";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const meta = document.createElement("span");
    meta.textContent = item.detail || "Open note";
    button.append(title, meta);
    button.addEventListener("click", () => openKbNote(item.index));
    list.appendChild(button);
  }
  card.append(heading, detail, list);
  card.hidden = digest.items.length === 0;
}
function markNoteProgress(index) {
  // Record against the note itself; study-progress.js derives its stable key.
  const note = localNoteFromBundle(localKbBundle, index);
  const next = recordNoteProgress(loadStudyProgress(), note, todayIso());
  try { localStorage.setItem(STUDY_PROGRESS_KEY, JSON.stringify(next)); } catch {}
  renderStudyProgress(next);
  renderReviewDigest(next);
}
// groups (owner request #11). Opening a course used to spill ALL notes (e.g.
// 343 for "Matematika 1") in one flat list — overwhelming. This groups by the
// note `topic`, detects "Šprint N …" sprint topics, and orders them:
//   1. sprints first, in NUMERIC order (so "Šprint 10" sorts after "Šprint 5",
//      not lexically before "Šprint 2"),
//   2. then all other named topics (stable, first-seen order),
//   3. then a single trailing "Other" group for untopiced notes.
// Each group is { key, label, isSprint, sprintNum, count, notes } so the UI can
// render a Course > Sprint/Topic accordion, collapsed by default. Pure (no DOM).
// ---------------------------------------------------------------------------
const OTHER_GROUP_LABEL = "Other";
export function groupCourseNotesBySprint(notes) {
  const list = Array.isArray(notes) ? notes : [];
  const groups = new Map(); // key -> group
  let order = 0;
  for (const n of list) {
    const rawTopic = (n && n.topic != null ? String(n.topic).trim() : "");
    const key = rawTopic || OTHER_GROUP_LABEL;
    let g = groups.get(key);
    if (!g) {
      // Detect "Šprint N …" / "Sprint N …" (accent- and case-insensitive).
      const m = rawTopic.match(/^(?:š|s)print\s+(\d+)/i);
      g = {
        key,
        label: key,
        isSprint: !!m,
        sprintNum: m ? Number(m[1]) : null,
        seen: order++,
        notes: [],
      };
      groups.set(key, g);
    }
    g.notes.push(n);
  }
  const arr = [...groups.values()];
  arr.sort((a, b) => {
    // Sprints first, ordered numerically.
    if (a.isSprint && b.isSprint) return a.sprintNum - b.sprintNum;
    if (a.isSprint) return -1;
    if (b.isSprint) return 1;
    // "Other" (untopiced) always sinks to the very bottom.
    const aOther = a.key === OTHER_GROUP_LABEL;
    const bOther = b.key === OTHER_GROUP_LABEL;
    if (aOther && !bOther) return 1;
    if (bOther && !aOther) return -1;
    // Remaining named topics keep first-seen (stable) order.
    return a.seen - b.seen;
  });
  return arr.map(({ key, label, isSprint, sprintNum, notes }) => ({
    key,
    label,
    isSprint,
    sprintNum,
    count: notes.length,
    notes,
  }));
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

export function shouldAutoBuildKb(settings = {}, bundle = null) {
  return settings?.autoBuild === true && (!Array.isArray(bundle?.notes) || bundle.notes.length === 0);
}

/** Decide which KB surface is safe before/after private bundle discovery. */
export function kbBuildSurfaceModel({ state = "loading" } = {}) {
  const showBuildCard = state === "empty";
  return { showBuildCard, showMain: !showBuildCard };
}

/** Return the destination nav target that should regain focus after a KB modal closes. */
export function kbViewTransitionFocusTargetModel({ from = "", to = "", modalWasOpen = false } = {}) {
  if (from !== "kb" || !modalWasOpen || !["planner", "archive"].includes(to)) return null;
  return to;
}

/** Describe route-transition focus restoration without persisting or exposing note content. */
export function kbViewTransitionFocusAnnouncementModel(view = "") {
  const labels = { planner: "Planner", archive: "Archive" };
  const label = labels[view];
  if (!label) return null;
  return {
    role: "status",
    live: "polite",
    atomic: "true",
    text: `${label} view opened. Focus restored to ${label} navigation.`,
  };
}

/**
 * Keep route-transition focus markers in the UI-only channel. Unknown text is
 * discarded so note bodies or other private content cannot be persisted or
 * accidentally included in a tutor request by future callers.
 */
export function routeTransitionFocusPrivacyModel(text = "") {
  const allowed = new Set([
    kbViewTransitionFocusAnnouncementModel("planner")?.text,
    kbViewTransitionFocusAnnouncementModel("archive")?.text,
  ]);
  const safeText = allowed.has(String(text)) ? String(text) : "";
  return { storage: null, tutor: null, text: safeText };
}

/** Describe the visible surface while an incremental Classroom build is running. */
/**
 * Which surface shows build progress.
 *
 * `inline` means the build was started from the "new courses" banner, so the
 * banner itself reports progress: same box, same place, same height. The full
 * build card is 520px wide with a 140px log and `margin: 2rem auto`, so
 * dropping it in above #kbMain shoved the entire page down — a jarring amount
 * of movement for a background top-up of an existing corpus.
 */
export function kbBuildStartModel({ inline = false } = {}) {
  return {
    onboardingHidden: true,
    mainVisible: true,
    panelVisible: !inline,
    inlineVisible: inline,
  };
}

/** Keep async related-note previews from collapsing while local notes resolve. */
export function relatedPreviewSurfaceModel({ state = "loading" } = {}) {
  if (state === "empty") return { visible: false, loading: false, error: false };
  if (state === "error") return { visible: true, loading: false, error: true };
  return { visible: true, loading: state === "loading", error: false };
}

export function relatedPreviewRetryModel() {
  return { label: "Retry related notes", ariaLabel: "Retry loading related notes", focusable: true };
}

export function relatedPreviewErrorModel(attempt = 1) {
  const count = Number.isFinite(attempt) && attempt > 1 ? Math.floor(attempt) : 1;
  const message = count === 1 ? "Related notes unavailable" : "Related notes still unavailable";
  const suffix = count === 1 ? "" : ` after ${count} attempts`;
  return {
    message,
    announcement: `${message}${suffix}. Retry loading related notes.`,
  };
}

/** Return a safe focus target for the control that opened the note modal. */
export function noteModalFocusTargetModel({ origin = "", connected = false } = {}) {
  const target = typeof origin === "string" ? origin.trim() : "";
  return target && connected ? target : null;
}

/** Describe note-modal transitions without ever including note body content. */
export function noteModalAnnouncementModel(state, title = "") {
  const normalizedState = typeof state === "string" ? state.trim() : "";
  if (normalizedState === "open") {
    const safeTitle = typeof title === "string" ? title.trim().slice(0, 160) : "";
    return {
      role: "status",
      live: "polite",
      atomic: "true",
      text: safeTitle ? `Opened note: ${safeTitle}.` : "Opened note.",
    };
  }
  if (normalizedState === "error") {
    return { role: "status", live: "polite", atomic: "true", text: "Note could not be loaded." };
  }
  return { role: "status", live: "polite", atomic: "true", text: "Note closed." };
}

function announceNoteModal(state, title = "") {
  const status = $("kbNoteModalStatus");
  if (!status) return;
  const announcement = noteModalAnnouncementModel(state, title);
  status.setAttribute("role", announcement.role);
  status.setAttribute("aria-live", announcement.live);
  status.setAttribute("aria-atomic", announcement.atomic);
  // Clear first so repeated opens/closes with the same title are announced.
  status.textContent = "";
  status.textContent = announcement.text;
}

export async function maybeAutoBuildKb() {
  const bundle = await loadKbBundle();
  if (!shouldAutoBuildKb(loadKbSettings(), bundle)) return false;
  startScrape();
  return true;
}

// ---------------------------------------------------------------------------
// Study tabs — Search · Browse · Curriculum · Manage.
//
// Archive and the Knowledge Base each had their own way to find a note; the
// merged page has one place for each job instead. The panels are mutually
// exclusive, so nothing on this page answers the same question twice.
// ---------------------------------------------------------------------------

let activeStudyTab = "search";

export function setStudyTab(requested) {
  const model = studyTabModel(requested);
  activeStudyTab = model.active;
  for (const { tab, hidden } of model.panels) {
    const panel = $(`studyPanel-${tab}`);
    if (panel) panel.hidden = hidden;
  }
  document.querySelectorAll(".study-tab-btn").forEach((btn) => {
    const on = btn.dataset.tab === model.active;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  // Each panel loads its own content on entry — the corpus can be large and
  // rendering all four up front is wasted work on a phone.
  if (model.active === "browse") showBrowsePanel();
  else hideBrowsePanel();
  if (model.active === "curriculum") renderStudyCurriculum();
  return model.active;
}

// Curriculum filter/sort state. Persisted like the Browse selection is, so
// coming back to the tab does not silently drop the range you were reading.
const KB_CURRICULUM_STATE_KEY = "cwa_kb_curriculum_state";

function loadKbCurriculumState() {
  try {
    return curriculumControlsModel(JSON.parse(localStorage.getItem(KB_CURRICULUM_STATE_KEY) || "null"));
  } catch { return curriculumControlsModel(); }
}

function saveKbCurriculumState(value) {
  const state = curriculumControlsModel(value);
  try { localStorage.setItem(KB_CURRICULUM_STATE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  return state;
}

function renderStudyCurriculum(controls = loadKbCurriculumState()) {
  const grid = $("kbCurriculumGrid");
  // The search box is re-created on every render, so put the caret back where
  // it was — otherwise typing a second character loses focus to the container.
  const active = document.activeElement;
  const restoreId = grid && active && grid.contains(active) ? active.id : "";
  const caret = restoreId && typeof active.selectionStart === "number" ? active.selectionStart : null;

  renderCurriculum(grid, localKbBundle, {
    controls,
    onControlsChange: (next) => renderStudyCurriculum(saveKbCurriculumState(next)),
    onOpenCourse: (course, year) => {
      // A chip is a way into the corpus, not a dead end: land on Browse with
      // that course already open.
      setStudyTab(studyTabForAction("open-course", activeStudyTab));
      openCourse(course, year || "");
    },
  });

  if (restoreId) {
    const again = $(restoreId);
    if (again) {
      again.focus();
      if (caret !== null && typeof again.setSelectionRange === "function") {
        try { again.setSelectionRange(caret, caret); } catch { /* not a text input */ }
      }
    }
  }
}

export function showKbView() {
  wireKbEvents(); // ensure search/tutor listeners are attached (idempotent)
  markStudyActivity();
  applyKbDensity();
  const v = $("kbView");
  if (!v) return;
  v.hidden = false;
  refreshKb();
}

// Planner→KB bridge: jump from an assignment straight into a KB search for its
// topic. `topic` is a free-text query (e.g. the assignment title or course).
// Switches to the KB view, prefills the search box, and runs the search.
export function kbSearchTopic(topic) {
  const t = (topic || "").trim();
  showKbView();
  const input = $("kbSearchInput");
  if (input) {
    input.value = t;
    runKbSearch(t);
  } else {
    refreshKb();
  }
}

let localKbBundle = null;
let noteModalOrigin = null;

export async function refreshKb() {
  const onboarding = $("kbOnboarding");
  const main = $("kbMain");
  const buildPanel = $("kbBuildPanel");
  const metaBar = $("kbMetaBar");
  const loadingSurface = kbBuildSurfaceModel({ state: "loading" });
  // Do not flash a build/scrape card while IndexedDB is deciding whether a
  // private bundle exists. A populated bundle must show study UI immediately;
  // the build card is revealed only after a confirmed empty result.
  if (onboarding) onboarding.hidden = !loadingSurface.showBuildCard;
  if (main) main.hidden = !loadingSurface.showMain;
  if (buildPanel) buildPanel.hidden = true;
  renderStudyStreak(loadStudyActivity());
  // Explicit loading state (owner #1/#2): show that the KB is FETCHING, not
  // empty, so the user can always tell "still loading" from "nothing there".
  // Cleared once we know whether a DB exists (renderKbMeta overwrites it).
  if (metaBar) metaBar.innerHTML = '<span class="kb-loading-inline">Loading your knowledge base…</span>';
  if (main) main.hidden = false;
  let meta = null;
  let checkpoint = null;
  try {
    localKbBundle = await loadKbBundle();
    checkpoint = kbBuildCheckpointModel(await loadKbBuildCheckpoint().catch(() => null));
    renderStudyProgress();
    renderReviewDigest();
    if (localKbBundle?.notes?.length) {
      meta = {
        noteCount: localKbBundle.notes.length,
        years: localKbBundle.years || [],
        courses: Array.isArray(localKbBundle.courses) ? localKbBundle.courses.length : 0,
        generatedAt: localKbBundle.generatedAt || null,
        updatedAt: localKbBundle.generatedAt || null,
      };
      renderKbMeta(meta);
      if (main) main.hidden = false;
      if (onboarding) onboarding.hidden = true;
    }
  } catch (error) {
    localKbBundle = null;
    checkpoint = null;
    console.warn("[KB] local state discovery failed", error?.name || "unknown");
  }
  const hasDb = !!(meta && meta.noteCount > 0);
  const hasCheckpoint = !hasDb && checkpoint && checkpoint.completedCourseIds.length > 0;
  const surface = kbBuildSurfaceModel({ state: hasDb || hasCheckpoint ? "populated" : "empty" });
  if (onboarding) onboarding.hidden = !surface.showBuildCard;
  if (main) main.hidden = !surface.showMain;
  if (hasCheckpoint) {
    if (buildPanel) buildPanel.hidden = false;
    const resume = $("kbResumeBuildBtn");
    if (resume) resume.hidden = false;
    const status = $("kbBuildStatus");
    if (status) {
      const summary = kbBuildResumeSummaryModel(checkpoint);
      status.textContent = `${summary.label} Resume when signed in.`;
    }
  }
  if (hasDb) {
    renderKbMeta(meta);
    void checkForClassroomChanges(localKbBundle);
    void maybeBackgroundSync();
    // Browse is its own tab now, so this no longer force-shows it under the
    // search box — that was the page answering "find me a note" twice at once.
    // Restore whichever tab is active; each loads its own content.
    setStudyTab(activeStudyTab);
    const search = $("kbSearchInput");
    if (!search || !search.value.trim()) renderExamples();
  }
}

/**
 * The school years, as a range rather than a list.
 *
 * Four school years spelled out ("2023-24, 2024-25, 2025-26, 2026-27") is 39
 * characters and on a phone wrapped the stat bar onto its own extra line, to
 * say something a nine-character range says just as well.
 */
export function kbMetaYearRange(years) {
  const list = (Array.isArray(years) ? years : [])
    .map((y) => String(y || "").trim())
    .filter((y) => /^\d{4}-\d{2}$/.test(y))
    .sort();
  if (list.length === 0) return "—";
  if (list.length === 1) return list[0];
  return `${list[0].slice(0, 4)}–${list[list.length - 1].slice(5)}`;
}

/**
 * How long ago the corpus was last updated, in words.
 *
 * `toLocaleString()` produced things like "08/09/2026, 07:15:00" — precision
 * nobody reads, in the widest possible form. What matters is whether it is
 * current.
 */
export function kbMetaUpdatedLabel(iso, now = Date.now()) {
  const then = Date.parse(String(iso || ""));
  if (!Number.isFinite(then)) return "never";
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 0) return "just now";
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function renderKbMeta(meta) {
  const bar = $("kbMetaBar");
  if (!bar || !meta) return;
  const yrs = kbMetaYearRange(meta.years);
  const updated = kbMetaUpdatedLabel(meta.updatedAt || meta.generatedAt);
  // textContent per cell: course and year strings come from Classroom.
  bar.replaceChildren();
  const cells = [
    ["📚", `${meta.noteCount?.toLocaleString() ?? 0}`, "notes"],
    ["🏫", `${meta.courses ?? 0}`, "courses"],
    ["📅", yrs, ""],
    ["🕑", updated, ""],
  ];
  for (const [icon, value, suffix] of cells) {
    const span = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = value;
    span.append(`${icon} `, strong);
    if (suffix) span.append(` ${suffix}`);
    bar.appendChild(span);
  }
  bar.title = `${meta.noteCount ?? 0} notes across ${meta.courses ?? 0} courses · updated ${meta.updatedAt || meta.generatedAt || "never"}`;
}

// The "new courses" banner doubles as the progress surface for the update it
// offers, so accepting the offer does not move the page.
let kbBuildInlineActive = false;

/** Put the banner into progress mode, keeping its exact box. */
function renderInlineBuildProgress(message, { percent = null, onCancel = null } = {}) {
  const banner = $("kbChangesBanner");
  if (!banner) return null;
  let text = banner.querySelector(".kb-update-text");
  let bar = banner.querySelector(".kb-update-progress-bar");
  if (!text || !bar) {
    banner.replaceChildren();
    banner.classList.add("is-building");
    text = document.createElement("span");
    text.className = "kb-update-text";
    banner.appendChild(text);
    if (onCancel) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "link-btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", onCancel);
      banner.appendChild(cancel);
    }
    // A 3px rule pinned to the banner's bottom edge: visible progress that
    // costs no height, so nothing below it moves while the build runs.
    const track = document.createElement("span");
    track.className = "kb-update-progress";
    bar = document.createElement("span");
    bar.className = "kb-update-progress-bar";
    track.appendChild(bar);
    banner.appendChild(track);
  }
  if (message != null) text.textContent = message;
  if (percent != null) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  banner.hidden = false;
  return banner;
}

/** Leave progress mode. */
function clearInlineBuildProgress({ message = "", isError = false } = {}) {
  const banner = $("kbChangesBanner");
  if (!banner) return;
  banner.classList.remove("is-building");
  banner.classList.toggle("is-error", !!isError);
  if (!message) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  banner.replaceChildren();
  const text = document.createElement("span");
  text.className = "kb-update-text";
  text.textContent = message;
  banner.appendChild(text);
  banner.hidden = false;
}

// Test hooks for scripts/inline_build_progress_test.mjs — the renderer is
// otherwise only reachable through a real Google Classroom build.
export function __setInlineBuildActiveForTest(value) { kbBuildInlineActive = !!value; }
export function __renderInlineBuildProgressForTest(message, opts) { return renderInlineBuildProgress(message, opts); }
export function __clearInlineBuildProgressForTest(opts) { return clearInlineBuildProgress(opts); }

// ---------------------------------------------------------------------------
// Keeping the corpus current on its own.
//
// The first build is manual: it reads every course and every year and is worth
// watching. Keeping up with a school week is not — the answer is usually one
// new assignment — so it happens quietly while the page is in use. There is no
// setting for this; kb-autosync.js works out which of the two a given moment
// calls for.
// ---------------------------------------------------------------------------
const KB_SYNC_ATTEMPT_KEY = "cwa_kb_last_sync_attempt";
let kbBackgroundSyncInFlight = false;

function loadLastSyncAttempt() {
  try { return localStorage.getItem(KB_SYNC_ATTEMPT_KEY) || null; } catch { return null; }
}
function saveLastSyncAttempt(value) {
  try { localStorage.setItem(KB_SYNC_ATTEMPT_KEY, value); } catch { /* private mode */ }
}

/** Show sync state in the stat bar's "updated" cell — the only surface it gets. */
function renderSyncStatus(state, counts) {
  const bar = $("kbMetaBar");
  if (!bar) return;
  const cell = bar.lastElementChild;
  if (!cell) return;
  const model = kbSyncStatusModel(state, counts);
  if (!model.label) return;
  cell.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = model.label;
  cell.append("🕑 ", strong);
  cell.classList.toggle("is-syncing", model.busy);
}

async function maybeBackgroundSync() {
  const decision = kbAutoSyncModel({
    hasCorpus: Array.isArray(localKbBundle?.notes) && localKbBundle.notes.length > 0,
    lastSyncAt: localKbBundle?.generatedAt || null,
    lastAttemptAt: loadLastSyncAttempt(),
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    signedIn: !!currentAccessToken(),
    buildInFlight: kbBuildInFlight || kbBackgroundSyncInFlight,
  });
  if (decision.action !== "background") return decision;

  kbBackgroundSyncInFlight = true;
  saveLastSyncAttempt(new Date().toISOString());
  const before = localKbBundle?.notes?.length ?? 0;
  renderSyncStatus("syncing");
  try {
    const token = currentAccessToken();
    const gFetch = async (url) => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const error = new Error(`Classroom API ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    };
    // ACTIVE courses only: an archived course is closed, and reconciliation
    // only touches courses a run actually covered, so this cannot delete
    // anything belonging to the years it skips.
    const archive = await buildArchiveFromClassroom(gFetch, { courseStates: ["ACTIVE"] });
    const bundle = await saveMergedKbBundle(kbBundleFromClassroomArchive(archive));
    localKbBundle = bundle;
    const added = Math.max(0, bundle.notes.length - before + (bundle.prunedCount || 0));
    renderSyncStatus("done", { added, removed: bundle.prunedCount || 0 });
    // Re-render what is on screen so new notes are actually reachable.
    renderStudyProgress();
    renderReviewDigest();
    setStudyTab(activeStudyTab);
    // The corpus just absorbed every ACTIVE course, so the "new courses" offer
    // is answered. Clearing it directly rather than re-running the check saves
    // a second full course listing moments after the build did one. A course
    // that is both new to the student AND already archived would be missed
    // until the next load, which is when the check runs again anyway.
    clearInlineBuildProgress();
    return { action: "background", reason: "done", added, removed: bundle.prunedCount || 0 };
  } catch (error) {
    // Quiet by design: a background top-up that cannot run is not the user's
    // problem to solve mid-sentence. The stat bar says so and the backoff in
    // kb-autosync.js keeps it from retrying on every page load.
    renderSyncStatus("failed");
    console.warn("[KB] background sync skipped:", error?.message || error);
    return { action: "background", reason: "failed" };
  } finally {
    kbBackgroundSyncInFlight = false;
  }
}

let kbChangeCheckInFlight = false;
async function checkForClassroomChanges(bundle) {
  const banner = $("kbChangesBanner");
  const token = currentAccessToken();
  if (!banner || !token || kbChangeCheckInFlight) return;
  kbChangeCheckInFlight = true;
  try {
    const response = await fetch("https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&courseStates=ARCHIVED&pageSize=100", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    const data = await response.json();
    const changes = detectClassroomChanges(bundle, data.courses);
    if (!changes.hasChanges) {
      // Clear a banner raised by an earlier check: once the corpus catches up,
      // the notice has to go away on its own.
      banner.hidden = true;
      banner.replaceChildren();
      return;
    }
    banner.replaceChildren();
    const label = document.createElement("span");
    // Same class the progress state uses, so the offer cannot wrap to two lines
    // while the progress line stays on one.
    label.className = "kb-update-text";
    label.textContent = classroomChangesMessage(changes.newCourses);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-btn";
    button.textContent = "Update now";
    button.addEventListener("click", () => {
      // The banner becomes the progress surface for the update it just offered,
      // rather than handing off to the full-page build card above #kbMain.
      startScrape({ inline: true });
    });
    banner.append(label, button);
    banner.hidden = false;
  } catch {}
  finally { kbChangeCheckInFlight = false; }
}

// ---------------------------------------------------------------------------
// Result-count summary (ROADMAP #55): build the human "Showing N of M notes"
// line the UI shows above the results, plus the active-filter annotation that
// makes the "clear filters" control meaningful. Pure + exported for unit tests.
// ---------------------------------------------------------------------------
export function buildResultSummary({ shown, total, course = "", year = "" }) {
  const unit = total === 1 ? "note" : "notes";
  const filters = [];
  if (course) filters.push(`course: ${course}`);
  if (year) filters.push(`year: ${year}`);
  const base = `Showing ${shown} of ${total} ${unit}`;
  return filters.length ? `${base} (filtered by ${filters.join(", ")})` : base;
}

const FILTER_SORT_LABELS = {
  relevance: "relevance",
  recency: "newest first",
  course: "course",
  title: "title",
};

/** Build a concise polite live-region announcement after KB filter/sort changes. */
export function buildFilterAnnouncement({ shown = 0, total = 0, course = "", year = "", kind = "", family = "", sort = "relevance" } = {}) {
  const filters = [
    course && `course ${course}`,
    year && `year ${year}`,
    kind && `type ${kind}`,
    family && `class type ${family}`,
  ].filter(Boolean);
  const filterText = filters.length ? `Filters: ${filters.join(", ")}.` : "No active filters.";
  const sortText = FILTER_SORT_LABELS[sort] || FILTER_SORT_LABELS.relevance;
  return `Showing ${shown} of ${total} ${total === 1 ? "note" : "notes"}. ${filterText} Sorted by ${sortText}.`;
}

// ---------------------------------------------------------------------------
// Export (private — the bundle lives in the user's own browser, exported
// only to their device; nothing is read from or written to a shared server DB)
// ---------------------------------------------------------------------------

// Client-side note download (ROADMAP §Reported #5): for a vault/local note
// with no web URL, let the student save the note as a .md file. Pure-ish:
// builds from the already-loaded note object, triggers a Blob download.
function downloadNoteAsMarkdown(note) {
  if (!note) return;
  const { filename, mime } = noteDownloadSpec(note);
  const front = [`# ${note.t || "Untitled"}`];
  if (note.course) front.push(`\nCourse: ${note.course}`);
  if (note.y) front.push(`Year: ${note.y}`);
  if (note.topic) front.push(`Topic: ${note.topic}`);
  if (note.p) front.push(`Source: ${note.p}`);
  const body = (note.x || note.s || "").trim();
  const md = front.join("\n") + "\n\n" + body + "\n";
  const blob = new Blob([md], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const EXPORT_MIME_TYPES = Object.freeze({
  json: "application/json",
  md: "text/markdown",
  csv: "text/csv",
});

export function noteDownloadSpec(note = {}) {
  const rawTitle = String(note?.t || "note");
  const sanitizedTitle = rawTitle.replace(/[\/\\?%*:"<>|]/g, "-").trim();
  const safeTitle = /[A-Za-z0-9]/.test(sanitizedTitle) ? sanitizedTitle : "note";
  return { filename: `${safeTitle}.md`, mime: "text/markdown" };
}

export function exportDownloadSpec(format, date = new Date().toISOString().slice(0, 10)) {
  if (!Object.hasOwn(EXPORT_MIME_TYPES, format)) {
    throw new Error(`Unsupported export format: ${format}`);
  }
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : "export";
  return { filename: `classroom-kb-${safeDate}.${format}`, mime: EXPORT_MIME_TYPES[format] };
}

function escapeCsvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function bundleToMarkdown(bundle) {
  const notes = Array.isArray(bundle.notes) ? bundle.notes : [];
  const lines = ["# Classroom Knowledge Base Export", ""];
  if (bundle.generatedAt) lines.push(`_Generated: ${new Date(bundle.generatedAt).toLocaleString()}_`, "");
  if (notes.length) lines.push(`_${notes.length} notes_`, "");
  // Group by course.
  const byCourse = new Map();
  for (const n of notes) {
    const c = n.course || "Uncategorised";
    if (!byCourse.has(c)) byCourse.set(c, []);
    byCourse.get(c).push(n);
  }
  for (const [course, ns] of byCourse) {
    lines.push(`## ${course}`, "");
    for (const n of ns) {
      const head = [n.t || "Untitled", n.y ? `(${n.y})` : "", n.topic ? `— ${n.topic}` : ""].filter(Boolean).join(" ");
      lines.push(`### ${head}`, "");
      // Derived summary (the ×3-weighted field) — front and centre.
      if (n.s) lines.push(`> ${n.s}`, "");
      if (Array.isArray(n.tags) && n.tags.length) lines.push(`*Tags: ${n.tags.join(", ")}*`, "");
      if (n.p) lines.push(`_Source: ${n.p}_`, "");
      const body = (n.x || "").trim();
      if (body) lines.push("", body);
      lines.push("", "---", "");
    }
  }
  return lines.join("\n");
}

function bundleToCsv(bundle) {
  const notes = Array.isArray(bundle.notes) ? bundle.notes : [];
  const rows = [["title", "course", "year", "topic", "tags", "summary", "body", "path"]];
  for (const n of notes) {
    rows.push([
      n.t || "",
      n.course || "",
      n.y || "",
      n.topic || "",
      Array.isArray(n.tags) ? n.tags.join("; ") : "",
      n.s || "",
      n.x || "",
      n.p || "",
    ].map(escapeCsvCell));
  }
  return rows.map((r) => r.join(",")).join("\n");
}

export function exportBundlePayload(bundle, format) {
  if (format === "json") return JSON.stringify(bundle, null, 2);
  if (format === "md") return bundleToMarkdown(bundle);
  if (format === "csv") return bundleToCsv(bundle);
  throw new Error(`Unsupported export format: ${format}`);
}

async function exportKb(format) {
  const status = $("kbExportStatus");
  const setStatus = (msg, isError) => {
    if (!status) return;
    status.textContent = msg;
    status.hidden = false;
    status.classList.toggle("error", !!isError);
  };
  setStatus("Preparing…");
  try {
    const bundle = await loadKbBundle();
    if (!bundle || !Array.isArray(bundle.notes) || bundle.notes.length === 0) {
      setStatus("Nothing to export yet — the knowledge base is empty.", true);
      return;
    }
    const { filename, mime } = exportDownloadSpec(format);
    downloadFile(filename, exportBundlePayload(bundle, format), mime);
    setStatus(`Exported ${bundle.notes.length} notes.`);
  } catch (err) {
    setStatus("Export failed: " + (err.message || err), true);
  }
}



// ---------------------------------------------------------------------------
// Tutor source attribution — turn the notes the RAG tutor actually used into
// clickable chip descriptors the UI renders. Each chip keeps the note index so
// a click can open the full note in the detail modal (openKbNote).
// ---------------------------------------------------------------------------
export function tutorSourceList(notes) {
  if (!Array.isArray(notes)) return [];
  const seen = new Set();
  const out = [];
  for (const n of notes) {
    if (!n || n.noteIndex === undefined || n.noteIndex === null) continue;
    if (seen.has(n.noteIndex)) continue; // de-dupe by index
    seen.add(n.noteIndex);
    out.push({
      noteIndex: n.noteIndex,
      title: n.t || "(untitled)",
      subtitle: [n.course, n.y].filter(Boolean).join(" · "),
    });
  }
  return out;
}
let _kbWired = false;
export function wireKbEvents() {
  if (_kbWired) return; // idempotent — safe to call multiple times
  _kbWired = true;
  let savedSearchState = null;
  try { savedSearchState = JSON.parse(localStorage.getItem(KB_SEARCH_STATE_KEY) || "null"); } catch {}
  const sortWasSaved = savedSearchState && typeof savedSearchState === "object" && Object.keys(savedSearchState).length > 0;
  kbSortExplicit = Boolean(sortWasSaved);
  const loadedSearchState = loadKbSearchState();
  kbActiveCourse = loadedSearchState.course;
  kbActiveYear = loadedSearchState.year;
  kbActiveKind = loadedSearchState.kind;
  kbActiveFamily = loadedSearchState.family;
  kbActiveSort = loadedSearchState.sort;
  const buildBtn = $("kbBuildBtn");
  const resumeBtn = $("kbResumeBuildBtn");
  const fileLink = $("kbLoadFileLink");
  const fileInput = $("kbFileInput");
  const tutorOpen = $("kbTutorOpen");
  const tutorClose = $("kbTutorClose");
  const tutorForm = $("kbTutorForm");
  const tutorInput = $("kbTutorInput");
  const tutorClearChat = $("kbTutorClearChat");
  const tutorNewTopic = $("kbTutorNewTopic");
  tutorThreadTitle = loadTutorThreadTitle();
  const threadTitle = $("kbTutorThreadTitle");
  if (threadTitle) threadTitle.textContent = tutorThreadTitle;
  renderTutorThreadArchive();
  $("kbTutorRenameThread")?.addEventListener("click", () => {
    const next = typeof window.prompt === "function"
      ? window.prompt("Name this tutor thread", tutorThreadTitle)
      : null;
    if (next !== null) saveTutorThreadTitle(next);
  });
  $("kbTutorArchiveThread")?.addEventListener("click", archiveCurrentTutorThread);

  buildBtn?.addEventListener("click", () => startScrape());
  resumeBtn?.addEventListener("click", () => startScrape());
  fileLink?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", (e) => handleKbFile(e));

  document.querySelectorAll(".study-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setStudyTab(btn.dataset.tab));
  });
  // Manage reuses the onboarding controls rather than duplicating their logic:
  // the two are never on screen together (onboarding shows only in the empty
  // state), so this is one build path and one import path with two entry points.
  $("kbRebuildBtn")?.addEventListener("click", () => startScrape());
  $("kbManageLoadFileLink")?.addEventListener("click", () => fileInput?.click());
  $("kbBuildCancelBtn")?.addEventListener("click", () => cancelKbBuild());

  tutorOpen?.addEventListener("click", () => { const m = $("kbTutorModal"); if (m) m.hidden = false; });
  tutorClose?.addEventListener("click", () => { const m = $("kbTutorModal"); if (m) m.hidden = true; });
  tutorClearChat?.addEventListener("click", clearTutorUi);
  tutorNewTopic?.addEventListener("click", resetTutorUi);
  tutorForm?.addEventListener("submit", (e) => { e.preventDefault(); const v = tutorInput?.value.trim(); if (v) sendTutor(v); });
  document.querySelectorAll("#kbTutorModal .ai-quick button").forEach((b) =>
    b.addEventListener("click", () => { const p = b.dataset.prompt; if (p) sendTutor(p); })
  );

  // Note-detail modal (opened by clicking a result card).
  $("kbNoteClose")?.addEventListener("click", closeKbNote);
  $("kbNoteCloseBtn")?.addEventListener("click", closeKbNote);

  const search = $("kbSearchInput");
  search?.addEventListener("input", debounce(() => { markStudyActivity(); runKbSearch(search.value); }, 200));

  // Focus area 7: explicit sort order. Changing the dropdown re-runs the search
  // with the chosen sort (default relevance, which is omitted server-side).
  const sortSel = $("kbSort");
  if (sortSel) sortSel.value = kbActiveSort;
  sortSel?.addEventListener("change", () => {
    kbSortExplicit = true;
    kbActiveSort = sortSel.value || "relevance";
    saveKbSearchState({ course: kbActiveCourse, year: kbActiveYear, kind: kbActiveKind, family: kbActiveFamily, sort: kbActiveSort });
    const input = $("kbSearchInput");
    runKbSearch(input ? input.value : "");
  });

  // Browse-by-course: "back to all courses" returns to the course grid.
  $("kbBrowseBack")?.addEventListener("click", backToBrowseCourses);

  // Browse filter/sort bar. Every control writes the shared state and re-renders
  // whichever view is showing, so the grid and the in-course list stay in step
  // instead of each owning a private copy of the year.
  const browseUpdate = (patch) => {
    kbBrowseState = saveKbBrowseState({ ...kbBrowseState, ...patch });
    refreshBrowse();
  };
  const browseSearch = $("kbBrowseSearch");
  // Debounced: filtering re-renders the whole list, and a large course would
  // otherwise re-render on every keystroke.
  let browseSearchTimer = null;
  browseSearch?.addEventListener("input", () => {
    clearTimeout(browseSearchTimer);
    browseSearchTimer = setTimeout(() => browseUpdate({ q: browseSearch.value }), 150);
  });
  $("kbBrowseYear")?.addEventListener("change", (e) => browseUpdate({ year: e.target.value }));
  $("kbBrowseFamily")?.addEventListener("change", (e) => browseUpdate({ family: e.target.value }));
  $("kbBrowseTopic")?.addEventListener("change", (e) => browseUpdate({ topic: e.target.value }));
  $("kbBrowseSort")?.addEventListener("change", (e) => {
    browseUpdate(kbCurrentCourse ? { noteSort: e.target.value } : { gridSort: e.target.value });
  });
  $("kbBrowseRecent")?.addEventListener("change", (e) => browseUpdate({ recent: e.target.checked }));
  $("kbBrowseReset")?.addEventListener("click", () => {
    // Reset clears the filters, not your place: the course you are reading
    // stays open.
    kbBrowseState = saveKbBrowseState({ ...kbBrowseStateModel(), course: kbCurrentCourse });
    refreshBrowse();
    $("kbBrowseSearch")?.focus();
  });

  // Keyboard shortcuts (agent-proposed backlog):
  //   "/"  -> focus the KB search box from anywhere in the view.
  //   Esc  -> clear the search box (and its results) when it's focused.
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable);
    if (e.key === "/" && !typing) {
      const box = $("kbSearchInput");
      if (box) { e.preventDefault(); box.focus(); }
    } else if (e.key === "Escape" && e.target && e.target.id === "kbSearchInput") {
      e.target.value = "";
      runKbSearch("");
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
      const tutorModal = $("kbTutorModal");
      const studyButtons = $("kbTutorMessages")?.querySelectorAll(".ai-study-mode-btn");
      const studyButton = studyButtons?.[studyButtons.length - 1];
      if (tutorModal && !tutorModal.hidden && studyButton && latestTutorAnswer(tutorMessages)) {
        e.preventDefault();
        studyButton.click();
      }
    }

    const resultList = $("kbResults");
    const cards = resultList ? [...resultList.querySelectorAll(".kb-result-card")] : [];
    const activeCard = cards.indexOf(document.activeElement);
    const fromSearch = e.target?.id === "kbSearchInput";
    if (cards.length && (fromSearch || activeCard >= 0)) {
      const next = kbResultNavigationIndex(fromSearch ? -1 : activeCard, e.key, cards.length);
      if (next !== null) {
        e.preventDefault();
        cards[next].focus();
      }
    }
  });

  // Export controls (local-only bundle export).
  $("kbExportJson")?.addEventListener("click", () => exportKb("json"));
  $("kbExportMd")?.addEventListener("click", () => exportKb("md"));
  $("kbExportCsv")?.addEventListener("click", () => exportKb("csv"));
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// In-flight "searching" affordance (owner #7 — loading state must look
// intentional, never a blank/stale panel). Cleared by the next render which
// replaces #kbResults content.
function showKbLoading() {
  const results = $("kbResults");
  if (!results) return;
  results.hidden = false;
  results.innerHTML =
    '<div class="kb-loading" role="status" aria-live="polite">' +
    '<span class="kb-spinner" aria-hidden="true"></span>' +
    "<span>Searching the knowledge base…</span></div>";
}

// accessToken lives in app.js's module scope; read it via the window mirror it
// exposes (window.__cwaAccessToken).
function currentAccessToken() {
  return (typeof window !== "undefined" && window.__cwaAccessToken) || null;
}

let kbBuildInFlight = false;
let kbBuildAbort = null; // AbortController for the running build, so it can be cancelled

/**
 * Stop an in-flight build.
 *
 * The Archive view had a cancel button and no resume; the KB had resume and no
 * cancel. The merged page keeps both — the checkpoint is written per completed
 * course, so cancelling mid-build leaves a resumable one behind rather than
 * throwing the work away.
 */
export function cancelKbBuild() {
  kbBuildAbort?.abort();
}

export async function startScrape({ inline = false } = {}) {
  if (kbBuildInFlight) return;
  kbBuildInFlight = true;
  kbBuildInlineActive = inline && !!$("kbChangesBanner");
  kbBuildAbort = new AbortController();
  const cancelBtn = $("kbBuildCancelBtn");
  if (cancelBtn) cancelBtn.hidden = !kbBuildInlineActive ? false : true;
  const panel = $("kbBuildPanel");
  const statusEl = $("kbBuildStatus");
  const showStatus = (msg, isError) => {
    if (kbBuildInlineActive) {
      if (isError) clearInlineBuildProgress({ message: msg, isError: true });
      else renderInlineBuildProgress(msg);
      return;
    }
    if (panel) panel.hidden = false;
    if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle("error", !!isError); }
  };

  const accessToken = currentAccessToken();
  if (!accessToken) {
    // Need a fresh Classroom token with the read-only scopes.
    if (!window.__cwaTokenClient) {
      kbBuildInFlight = false;
      kbBuildInlineActive = false;
      showStatus("Sign in with Google first (use the top-right button), then try again.", true);
      console.warn("[KB] startScrape: no token and no Google token client available.");
      return;
    }
    window.__cwaTokenClient.callback = (resp) => {
      if (resp.error) { kbBuildInFlight = false; showStatus("Google sign-in failed: " + resp.error, true); return; }
      doScrape(resp.access_token);
    };
    try {
      // Always show the account chooser so students can switch Classroom accounts;
      // scopes here MUST include the read-only set (see SCOPES in app.js).
      window.__cwaTokenClient.requestAccessToken({ prompt: INTERACTIVE_OAUTH_PROMPT });
    } catch (e) { kbBuildInFlight = false; showStatus("Could not start Google sign-in: " + e.message, true); }
    return;
  }
  doScrape(accessToken);
}

async function doScrape(token) {
  const checkpoint = kbBuildCheckpointModel(await loadKbBuildCheckpoint().catch(() => null));
  const panel = $("kbBuildPanel");
  const statusEl = $("kbBuildStatus");
  const logEl = $("kbBuildLog");
  const progress = $("kbBuildProgressBar");
  const buildSurface = kbBuildStartModel({ inline: kbBuildInlineActive });
  const onboarding = $("kbOnboarding");
  const main = $("kbMain");
  if (onboarding) onboarding.hidden = buildSurface.onboardingHidden;
  if (main) main.hidden = !buildSurface.mainVisible;
  if (panel) panel.hidden = !buildSurface.panelVisible;
  if (buildSurface.inlineVisible) {
    renderInlineBuildProgress("Checking Google Classroom…", {
      percent: 5,
      onCancel: () => kbBuildAbort?.abort(),
    });
  }
  if (statusEl) {
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    statusEl.setAttribute("aria-atomic", "true");
    statusEl.textContent = "Reading your courses privately in this browser…";
    statusEl.classList.remove("error");
  }
  if (logEl) logEl.innerHTML = "";
  if (progress) progress.style.width = "5%";
  const log = (msg) => { if (logEl) { const li = document.createElement("div"); li.textContent = msg; logEl.appendChild(li); } };
  const gFetch = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const error = new Error(`Classroom API ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  try {
    const archive = await buildArchiveFromClassroom(gFetch, {
      signal: kbBuildAbort?.signal,
      checkpoint: checkpoint.showBuildCard ? null : checkpoint,
      saveCheckpoint: (next) => saveKbBuildCheckpoint(kbBuildCheckpointModel(next)),
      onProgress: ({ message, done, total }) => {
        const percent = total ? Math.round((done / total) * 90) + 5 : null;
        if (message) {
          const status = kbBuildProgressStatusModel({ message, done, total });
          if (statusEl) statusEl.textContent = status.message;
          if (kbBuildInlineActive) renderInlineBuildProgress(status.message, { percent });
          log(message);
        } else if (kbBuildInlineActive && percent != null) {
          renderInlineBuildProgress(null, { percent });
        }
        if (progress && percent != null) progress.style.width = `${percent}%`;
      },
    });
    // Merge, never replace: a rebuild must not discard past years that were
    // imported from a School Backup export.
    const bundle = await saveMergedKbBundle(kbBundleFromClassroomArchive(archive));
    localKbBundle = bundle;
    await removeKbBuildCheckpoint();
    if (progress) progress.style.width = "100%";
    const done = `✅ Saved ${bundle.notes.length.toLocaleString()} notes locally in this browser.`;
    if (statusEl) statusEl.textContent = done;
    if (kbBuildInlineActive) renderInlineBuildProgress(done, { percent: 100 });
    // refreshKb re-runs the change check, which clears the banner outright once
    // the corpus has caught up.
    setTimeout(() => refreshKb(), 600);
  } catch (e) {
    if (classroomAuthRecoveryModel(e?.status).resetSession) {
      window.dispatchEvent(new CustomEvent("cwa-classroom-auth-error", {
        detail: { status: e.status },
      }));
      return;
    }
    if (e?.name === "AbortError") {
      // Not a failure. The per-course checkpoint survives, so say what the
      // Resume button will do rather than showing an error.
      const cancelled = "Cancelled — resume any time to pick up where it stopped.";
      if (statusEl) { statusEl.classList.remove("error"); statusEl.textContent = cancelled; }
      if (kbBuildInlineActive) clearInlineBuildProgress({ message: cancelled });
      await refreshKb();
      return;
    }
    setKbBuildError(e.message);
  } finally {
    kbBuildInFlight = false;
    kbBuildAbort = null;
    kbBuildInlineActive = false;
    const cancelBtn = $("kbBuildCancelBtn");
    if (cancelBtn) cancelBtn.hidden = true;
  }
}

function setKbBuildError(msg) {
  const statusEl = $("kbBuildStatus");
  if (statusEl) { statusEl.textContent = `❌ ${msg}`; statusEl.classList.add("error"); }
  // An inline build has no visible build card to put the error in.
  if (kbBuildInlineActive) clearInlineBuildProgress({ message: `❌ ${msg}`, isError: true });
}

async function handleKbFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const statusEl = $("kbBuildStatus");
  const panel = $("kbBuildPanel");
  if (panel) panel.hidden = false;
  if (statusEl) statusEl.textContent = "Adding archive.json to your knowledge base…";
  try {
    const text = await file.text();
    let parsed; try { parsed = JSON.parse(text); } catch { setKbBuildError("That file isn't valid JSON."); return; }
    // Same rule in the other direction: importing past years must not discard
    // the current Classroom build.
    const bundle = await saveMergedKbBundle(kbBundleFromClassroomArchive(parsed));
    localKbBundle = bundle;
    if (statusEl) statusEl.textContent = `✅ Saved ${bundle.notes.length.toLocaleString()} notes locally in this browser.`;
    setTimeout(() => refreshKb(), 600);
  } catch (err) { setKbBuildError(err.message); }
  finally { e.target.value = ""; }
}

// ---------------------------------------------------------------------------
// Public search (with course/year filter chips)
// ---------------------------------------------------------------------------
let kbActiveCourse = "";
let kbActiveYear = "";
let kbActiveKind = "";
let kbActiveFamily = "";
let kbActiveSort = "relevance";
let kbSortExplicit = false;
let kbCurrentCourse = "";

async function runKbSearch(query) {
  const results = $("kbResults");
  if (!results) return;
  query = (query || "").trim();
  const effectiveSort = kbSortForQuery(query, kbActiveSort, { explicit: kbSortExplicit });
  const scope = kbScopeFilters(loadKbSettings(), { course: kbActiveCourse }, {
    currentCourse: kbCurrentCourse,
    pinnedCourses: loadKbPinnedCourses(),
  });
  const sortSelect = $("kbSort");
  if (sortSelect) sortSelect.value = effectiveSort;
  if (!query) {
    results.hidden = true;
    results.innerHTML = "";
    const count = $("kbResultCount");
    if (count) { count.hidden = true; count.innerHTML = ""; }
    const chips = $("kbFilterChips");
    if (chips) chips.hidden = true;
    // No query → offer the example searches. Discovering by course lives on
    // the Browse tab, not stacked underneath this one.
    renderExamples();
    return;
  }
  // Typing while on Browse or Curriculum would otherwise search a panel the
  // user cannot see.
  if (activeStudyTab !== "search") setStudyTab(studyTabForAction("search", activeStudyTab));
  // Intentional IN-FLIGHT state: show a spinner so the brief fetch round-trip
  // (the KB reassembles 13 KV shards) never looks like a frozen/blank panel.
  showKbLoading();
  try {
    let d = buildLocalSearchResponse(localKbBundle, query, {
      course: kbActiveCourse,
      courses: kbActiveCourse ? [] : scope.courses,
      year: kbActiveYear,
      kind: kbActiveKind,
      family: kbActiveFamily,
      sort: effectiveSort,
      limit: 8,
    });
    results.hidden = false;
    results.innerHTML = "";
    renderFilterChips(d.filters);
    renderResultCount(d, { course: kbActiveCourse, year: kbActiveYear });
    if (!d.results || d.results.length === 0) {
      const meta = d.meta || {};
      const empty = document.createElement("div");
      empty.className = "empty";
      // Two DISTINCT empty states (owner #1): the KB genuinely has no notes
      // yet vs a real query that simply matched nothing. Never let a slow
      // fetch be mistaken for "empty" — the spinner covered that case above.
      if (!meta.noteCount) {
        empty.textContent = "Your knowledge base is empty — build it from Google Classroom (or upload an archive.json) to start searching.";
      } else {
        empty.textContent = "No matches in your knowledge base.";
      }
      results.appendChild(empty);
      if (d.didYouMean) {
        const dym = document.createElement("div");
        dym.className = "kb-didyoumean";
        const label = document.createElement("span");
        label.textContent = "Did you mean ";
        dym.appendChild(label);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "kb-didyoumean-btn";
        btn.textContent = d.didYouMean;
        btn.addEventListener("click", () => {
          const input = $("kbSearchInput");
          if (input) input.value = d.didYouMean;
          runKbSearch(d.didYouMean);
        });
        dym.appendChild(btn);
        dym.appendChild(document.createTextNode(" ?"));
        results.appendChild(dym);
      }
      return;
    }
    const contextBar = document.createElement("div");
    contextBar.className = "kb-result-actions";
    const copyContext = document.createElement("button");
    copyContext.id = "kbCopySearchContext";
    copyContext.type = "button";
    copyContext.className = "secondary kb-copy-context";
    copyContext.textContent = "Copy search context";
    const copyAgain = document.createElement("button");
    copyAgain.id = "kbCopySearchAgain";
    copyAgain.type = "button";
    copyAgain.className = "secondary kb-copy-context";
    const copyHistory = loadCopySearchContextHistory();
    copyAgain.textContent = copyHistory.count > 0 ? `Copy again (${copyHistory.count})` : "Copy again";
    copyAgain.hidden = !copyHistory.text;
    const copyShortcutHint = document.createElement("span");
    copyShortcutHint.id = "kbCopyShortcutHint";
    copyShortcutHint.className = "kb-copy-shortcut-hint";
    copyShortcutHint.textContent = "Shortcuts: / search · Esc clear";
    copyShortcutHint.title = "Press / to focus search or Esc to clear it";
    const copyStatus = document.createElement("span");
    copyStatus.id = "kbCopySearchStatus";
    copyStatus.className = "kb-copy-status";
    copyStatus.setAttribute("role", "status");
    copyStatus.setAttribute("aria-live", "assertive");
    copyStatus.setAttribute("aria-atomic", "true");
    const copyRetry = document.createElement("button");
    copyRetry.id = "kbCopySearchRetry";
    copyRetry.type = "button";
    copyRetry.className = "secondary kb-copy-context";
    copyRetry.textContent = "Retry copy";
    copyRetry.setAttribute("aria-label", "Retry clipboard copy");
    copyRetry.hidden = true;
    const copyHistoryEntry = document.createElement("span");
    copyHistoryEntry.id = "kbCopySearchHistoryEntry";
    copyHistoryEntry.className = "kb-copy-history-entry";
    copyHistoryEntry.setAttribute("aria-label", "Latest copied search context");
    copyHistoryEntry.textContent = loadCopySearchContextHistoryEntry().label;
    copyHistoryEntry.hidden = !copyHistory.count;
    const dismissCopyHistory = document.createElement("button");
    dismissCopyHistory.id = "kbDismissCopyHistory";
    dismissCopyHistory.type = "button";
    dismissCopyHistory.className = "secondary kb-copy-history-dismiss";
    dismissCopyHistory.textContent = "Dismiss";
    dismissCopyHistory.hidden = !copyHistory.count;
    const copySearchContextToClipboard = async ({ retry = false } = {}) => {
      const text = copySearchContext(d.results, { format: loadKbSettings().copyFormat });
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(text);
        saveCopySearchContextHistory(text, d.results.length, $("kbSearchInput")?.value || "");
        copyAgain.textContent = `Copy again (${d.results.length})`;
        copyAgain.hidden = false;
        copyRetry.hidden = true;
        copyHistoryEntry.textContent = copySearchContextHistoryEntryModel({ count: d.results.length, query: $("kbSearchInput")?.value || "", copiedAt: Date.now() }).label;
        copyHistoryEntry.hidden = false;
        dismissCopyHistory.hidden = false;
        announceCopyStatus(copyStatus, retry
          ? `Copied ${d.results.length} note${d.results.length === 1 ? "" : "s"} after retry.`
          : `Copied ${d.results.length} note${d.results.length === 1 ? "" : "s"} of titles and snippets.`);
        return true;
      } catch {
        copyRetry.hidden = false;
        announceCopyStatus(copyStatus, "Could not copy search context. Check clipboard permissions and try again.");
        copyRetry.focus();
        return false;
      }
    };
    copyContext.addEventListener("click", () => copySearchContextToClipboard());
    copyRetry.addEventListener("click", () => copySearchContextToClipboard({ retry: true }));
    copyAgain.addEventListener("click", async () => {
      const latest = loadCopySearchContextHistory();
      try {
        if (!latest.text || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(latest.text);
        copyRetry.hidden = true;
        announceCopyStatus(copyStatus, `Copied ${latest.count} note${latest.count === 1 ? "" : "s"} again.`);
      } catch {
        announceCopyStatus(copyStatus, "Could not copy the latest search context. Check clipboard permissions and try again.");
      }
    });
    dismissCopyHistory.addEventListener("click", () => {
      latestCopySearchContextText = "";
      try { localStorage.removeItem(KB_COPY_HISTORY_KEY); } catch {}
      copyAgain.hidden = true;
      copyHistoryEntry.hidden = true;
      dismissCopyHistory.hidden = true;
      announceCopyStatus(copyStatus, "Copy history dismissed from this browser.");
    });
    contextBar.append(copyContext, copyAgain, copyShortcutHint, copyStatus, copyRetry, copyHistoryEntry, dismissCopyHistory);
    results.appendChild(contextBar);
    // "Did you mean" — when a typo returned nothing but a confident
    // correction exists in the corpus, offer a one-click retry.
    if (d.didYouMean) {
      const dym = document.createElement("div");
      dym.className = "kb-didyoumean";
      const label = document.createElement("span");
      label.textContent = "Did you mean ";
      dym.appendChild(label);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kb-didyoumean-btn";
      btn.textContent = d.didYouMean;
      btn.addEventListener("click", () => {
        const input = $("kbSearchInput");
        if (input) input.value = d.didYouMean;
        runKbSearch(d.didYouMean);
      });
      dym.appendChild(btn);
      dym.appendChild(document.createTextNode(" ?"));
      results.appendChild(dym);
    }
  for (const note of d.results) {
      const row = document.createElement("div");
      row.className = "assignment kb-result-card";
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.dataset.noteIndex = String(note.noteIndex ?? "");
      if (note.noteIndex != null) row.id = `kb-result-${note.noteIndex}`;
      row.setAttribute("aria-label", `Open note: ${note.t || "(untitled)"}`);
      const body = document.createElement("div");
      body.className = "assignment-body";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = note.t || "(untitled)";
      body.appendChild(title);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = [note.course, note.y, note.topic].filter(Boolean).join(" · ");
      meta.appendChild(renderNotePinButton(note));
      body.appendChild(meta);
      if (note._snippet) {
        const snip = document.createElement("div");
        snip.className = "summary archive-snippet";
        snip.innerHTML = highlightSnippet(note._snippet, query);
        body.appendChild(snip);
      }
      // Related-notes preview: compact cross-links under the card so a
      // student can hop between related notes without opening each one.
      const preview = document.createElement("div");
      preview.className = "kb-related-preview";
      preview.classList.add("is-loading");
      const initialAnnouncement = relatedPreviewAnnouncement("loading", {
        cached: !!localKbBundle?.notes?.length,
      });
      preview.setAttribute("role", initialAnnouncement.role);
      preview.setAttribute("aria-live", initialAnnouncement.live);
      preview.setAttribute("aria-label", initialAnnouncement.text);
      preview.textContent = initialAnnouncement.text;
      body.appendChild(preview);
      row.appendChild(body);
      const open = () => {
        if (row.dataset.noteIndex !== "" && row.dataset.noteIndex != null) openKbNote(Number(row.dataset.noteIndex));
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
      results.appendChild(row);
      // Fill the preview asynchronously (reuses the related-notes route).
      if (note.noteIndex != null) renderRelatedPreview(preview, note.noteIndex);
    }
  } catch (e) {
    results.hidden = false;
    results.innerHTML = `<div class="empty">Search failed: ${e.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// "Browse by course" — a no-query discovery entry point (ROADMAP: richer
// empty state with a "browse by course" entry point). When the search box is
// empty we show (a) a row of example searches and (b) a course grid; clicking
// a course lists its notes from the cached private bundle
// in the same card shape the search results use.
// ---------------------------------------------------------------------------
export function kbBrowseRecentEmptyStateModel({ course = "", year = "" } = {}) {
  const cleanCourse = String(course || "").trim() || "this course";
  const cleanYear = String(year || "").trim();
  const scope = cleanYear ? `${cleanCourse} in ${cleanYear}` : cleanCourse;
  return {
    message: `No notes in ${scope} were studied in the last 7 days.`,
    actionLabel: cleanYear ? `Show all ${cleanCourse} notes in ${cleanYear}` : `Show all ${cleanCourse} notes`,
    actionAriaLabel: cleanYear ? `Show all ${cleanCourse} notes in ${cleanYear}` : `Show all ${cleanCourse} notes`,
    clearRecent: true,
  };
}

function exampleSearches() {
  return ["STAR method", "cover letter", "soft skills", "interview", "study guide"];
}

function renderExamples() {
  const wrap = $("kbExamples");
  if (!wrap) return;
  // Keep the static label, append one chip per example.
  wrap.querySelectorAll(".kb-example-chip").forEach((n) => n.remove());
  for (const ex of exampleSearches()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kb-chip kb-example-chip";
    b.textContent = ex;
    b.addEventListener("click", () => {
      const input = $("kbSearchInput");
      if (input) { input.value = ex; runKbSearch(ex); }
    });
    wrap.appendChild(b);
  }
  wrap.hidden = false;
}

// Which Browse view is showing, and the filters applied to it. One state
// object drives both the course grid and the in-course note list; the controls
// bar is a pure function of it, so nothing can drift the way the old
// per-course year <select> did.
let kbBrowseState = kbBrowseStateModel();

function setBrowseControlsMode(inCourse) {
  const search = $("kbBrowseSearch");
  if (search) {
    search.placeholder = inCourse ? "Filter notes…" : "Filter courses…";
    search.setAttribute("aria-label", inCourse ? "Filter notes by title" : "Filter courses by name");
  }
  const familyField = $("kbBrowseFamilyField");
  if (familyField) familyField.hidden = inCourse;
  const topicField = $("kbBrowseTopicField");
  if (topicField) topicField.hidden = !inCourse;
  const recentLabel = $("kbBrowseRecentLabel");
  if (recentLabel) recentLabel.hidden = !inCourse;
  const title = $("kbBrowseTitle");
  if (title) title.textContent = inCourse ? kbBrowseState.course || "Course" : "Browse by course";

  const sort = $("kbBrowseSort");
  if (sort) {
    const options = inCourse
      ? [["recency", "Newest first"], ["title", "By title"], ["course", "By topic"]]
      : [["notes", "Most notes"], ["alpha", "A–Z"], ["recent", "Newest year"]];
    sort.innerHTML = "";
    for (const [value, label] of options) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      sort.appendChild(o);
    }
    sort.value = inCourse ? kbBrowseState.noteSort : kbBrowseState.gridSort;
  }
}

/** Fill a <select> with facet values, keeping the current choice if it survives. */
function fillFacetSelect(select, values, anyLabel, current) {
  if (!select) return "";
  select.innerHTML = "";
  const any = document.createElement("option");
  any.value = "";
  any.textContent = anyLabel;
  select.appendChild(any);
  for (const value of values) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = value;
    select.appendChild(o);
  }
  const kept = values.includes(current) ? current : "";
  select.value = kept;
  // A facet with nothing to choose between is noise, not a control.
  const field = select.closest(".kb-controls-field");
  if (field && field.id) field.hidden = values.length === 0;
  return kept;
}

function syncBrowseControls({ inCourse, shown, total }) {
  const search = $("kbBrowseSearch");
  if (search && search.value !== kbBrowseState.q) search.value = kbBrowseState.q;
  const recent = $("kbBrowseRecent");
  if (recent) recent.checked = inCourse && kbBrowseState.recent;

  const count = $("kbBrowseCount");
  if (count) {
    const noun = inCourse ? "note" : "course";
    count.textContent = shown === total
      ? `${total} ${noun}${total === 1 ? "" : "s"}`
      : `${shown} of ${total} ${noun}s`;
  }
  const reset = $("kbBrowseReset");
  if (reset) reset.hidden = kbBrowseIsDefault(kbBrowseState, { inCourse });
}

function showBrowsePanel({ restore = true } = {}) {
  renderExamples();
  const panel = $("kbBrowse");
  if (panel) panel.hidden = false;
  kbBrowseState = restore ? loadKbBrowseState() : kbBrowseStateModel();
  const notesEl = $("kbBrowseNotes");
  if (notesEl) notesEl.hidden = true;
  // Restore the last local course when it still exists in this bundle.
  const hasCourse = restore && kbBrowseState.course && Array.isArray(localKbBundle?.notes)
    && localKbBundle.notes.some((note) => (note?.course || "Uncategorised") === kbBrowseState.course);
  if (hasCourse) openCourse(kbBrowseState.course, kbBrowseState.year);
  else { kbBrowseState.course = ""; loadBrowseCourses(); }
}

function hideBrowsePanel() {
  const panel = $("kbBrowse");
  if (panel) panel.hidden = true;
  const ex = $("kbExamples");
  if (ex) ex.hidden = true;
  const back = $("kbBrowseBack");
  if (back) back.hidden = true;
}

/** Back out of a course to the grid, keeping the corpus-wide filters. */
function backToBrowseCourses() {
  const notesEl = $("kbBrowseNotes");
  if (notesEl) notesEl.hidden = true;
  const back = $("kbBrowseBack");
  if (back) back.hidden = true;
  kbCurrentCourse = "";
  // Course-scoped filters do not survive leaving the course; year and type do.
  kbBrowseState = saveKbBrowseState({ ...kbBrowseState, course: "", topic: "", q: "", recent: false });
  loadBrowseCourses();
}

async function loadBrowseCourses() {
  const list = $("kbBrowseCourses");
  if (!list) return;
  setBrowseControlsMode(false);
  list.hidden = false;
  list.innerHTML = `<div class="empty">Loading courses…</div>`;
  try {
    // Facets come from the whole corpus, not the filtered slice, so choosing a
    // year never removes the option that would take you back.
    const keptYear = fillFacetSelect($("kbBrowseYear"), browseYearFacet(localKbBundle), "All years", kbBrowseState.year);
    const keptFamily = fillFacetSelect($("kbBrowseFamily"), browseFamilyFacet(localKbBundle), "All types", kbBrowseState.family);
    kbBrowseState = saveKbBrowseState({ ...kbBrowseState, year: keptYear, family: keptFamily });

    const unfiltered = browseKbBundle(localKbBundle, "", {}).courses || [];
    const d = browseKbBundle(localKbBundle, "", {
      year: kbBrowseState.year,
      family: kbBrowseState.family,
      courseSort: kbBrowseState.gridSort,
    });
    const needle = kbBrowseState.q.toLowerCase();
    const courses = (Array.isArray(d.courses) ? d.courses : [])
      .filter((c) => !needle || String(c.course).toLowerCase().includes(needle));

    syncBrowseControls({ inCourse: false, shown: courses.length, total: unfiltered.length });

    if (!unfiltered.length) { list.innerHTML = `<div class="empty">No courses yet — the knowledge base is empty.</div>`; return; }
    if (!courses.length) {
      list.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No courses match these filters.";
      list.appendChild(empty);
      return;
    }
    list.innerHTML = "";
    for (const c of courses) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "kb-course-card";
      card.setAttribute("aria-label", `Browse ${c.course} (${c.count} notes)`);
      const title = document.createElement("span");
      title.className = "kb-course-name";
      title.textContent = c.course;
      const meta = document.createElement("span");
      meta.className = "kb-course-meta";
      const yr = Array.isArray(c.years) && c.years.length ? c.years.join(", ") : "—";
      meta.textContent = `${c.count} note${c.count === 1 ? "" : "s"} · ${yr}`;
      card.appendChild(title);
      card.appendChild(meta);
      card.addEventListener("click", () => openCourse(c.course));
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = `<div class="empty">Couldn't load courses (${e.message}).</div>`;
  }
}

async function openCourse(course, year = "") {
  kbCurrentCourse = String(course || "").trim();
  setBrowseControlsMode(true);
  const list = $("kbBrowseCourses");
  const notesEl = $("kbBrowseNotes");
  const back = $("kbBrowseBack");

  // Entering a course from the Curriculum matrix carries a year with it; a
  // plain click from the grid keeps whatever year filter is already set.
  const requestedYear = String(year || "").trim();
  kbBrowseState = kbBrowseStateModel({
    ...kbBrowseState,
    course: kbCurrentCourse,
    year: requestedYear || kbBrowseState.year,
  });

  // Year options narrow to this course; type is a grid-level facet only.
  const courseYears = browseYearFacet(localKbBundle, kbCurrentCourse);
  const keptYear = fillFacetSelect($("kbBrowseYear"), courseYears, "All years", kbBrowseState.year);
  kbBrowseState.year = keptYear;
  const topics = browseTopicFacet(localKbBundle, kbCurrentCourse, keptYear);
  kbBrowseState.topic = fillFacetSelect($("kbBrowseTopic"), topics, "All topics", kbBrowseState.topic);
  kbBrowseState = saveKbBrowseState(kbBrowseState);

  const title = $("kbBrowseTitle");
  if (title) title.textContent = kbCurrentCourse;
  if (list) list.hidden = true;
  if (notesEl) { notesEl.hidden = false; notesEl.innerHTML = `<div class="empty">Loading ${course}…</div>`; }
  if (back) back.hidden = false;

  try {
    const scope = {
      year: kbBrowseState.year,
      topic: kbBrowseState.topic,
      sort: kbBrowseState.noteSort,
      recentDays: kbBrowseState.recent ? 7 : 0,
      today: todayIso(),
      progress: loadStudyProgress(),
    };
    // Total for the counter is the course before any filter, so "3 of 47" is
    // honest about how much the filters are hiding.
    const total = (browseKbBundle(localKbBundle, kbCurrentCourse, {}).notes || []).length;
    const d = browseKbBundle(localKbBundle, kbCurrentCourse, scope);
    const needle = kbBrowseState.q.toLowerCase();
    const notes = (Array.isArray(d.notes) ? d.notes : [])
      .filter((n) => !needle || String(n.t || "").toLowerCase().includes(needle)
        || String(n.topic || "").toLowerCase().includes(needle));

    syncBrowseControls({ inCourse: true, shown: notes.length, total });

    if (!notes.length) {
      if (notesEl) {
        if (kbBrowseState.recent) {
          const emptyState = kbBrowseRecentEmptyStateModel({ course, year: kbBrowseState.year });
          notesEl.innerHTML = "";
          const message = document.createElement("div");
          message.className = "empty";
          message.textContent = emptyState.message;
          const recover = document.createElement("button");
          recover.type = "button";
          recover.className = "secondary kb-browse-recent-recover";
          recover.textContent = emptyState.actionLabel;
          recover.setAttribute("aria-label", emptyState.actionAriaLabel);
          recover.addEventListener("click", () => {
            kbBrowseState = saveKbBrowseState({ ...kbBrowseState, recent: false });
            openCourse(kbCurrentCourse);
          });
          notesEl.append(message, recover);
        } else {
          notesEl.innerHTML = "";
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = kbBrowseIsDefault(kbBrowseState, { inCourse: true })
            ? `No notes in ${course}.`
            : `No notes in ${course} match these filters.`;
          notesEl.appendChild(empty);
        }
      }
      return;
    }
    if (notesEl) {
      notesEl.innerHTML = "";
      // Owner request #11 — fold the (often 100+) notes into collapsible
      // sprint/topic groups instead of one flat dump. Groups are collapsed by
      // default so the class view opens as a tidy sprint/topic tree.
      const groups = groupCourseNotesBySprint(notes);
      const header = document.createElement("div");
      header.className = "kb-course-groups-head";
      header.textContent = `${notes.length} note${notes.length === 1 ? "" : "s"} in ${groups.length} group${groups.length === 1 ? "" : "s"}`;
      notesEl.appendChild(header);
      // Expand the first group by default so the view isn't fully collapsed on
      // open; the rest stay closed to keep the tree tidy.
      groups.forEach((g, gi) => {
        const details = document.createElement("details");
        details.className = "kb-sprint-group" + (g.isSprint ? " is-sprint" : "");
        if (gi === 0) details.open = true;
        const summary = document.createElement("summary");
        summary.className = "kb-sprint-summary";
        const gLabel = document.createElement("span");
        gLabel.className = "kb-sprint-label";
        gLabel.textContent = g.label;
        const gCount = document.createElement("span");
        gCount.className = "kb-sprint-count";
        gCount.textContent = `${g.count}`;
        summary.appendChild(gLabel);
        summary.appendChild(gCount);
        details.appendChild(summary);
        for (const note of g.notes) {
          const row = document.createElement("div");
          row.className = "assignment kb-result-card";
          row.tabIndex = 0;
          row.setAttribute("role", "button");
          row.dataset.noteIndex = String(note.noteIndex ?? "");
          row.setAttribute("aria-label", `Open note: ${note.t || "(untitled)"}`);
          const body = document.createElement("div");
          body.className = "assignment-body";
          const title = document.createElement("div");
          title.className = "title";
          title.textContent = note.t || "(untitled)";
          body.appendChild(title);
          const meta = document.createElement("div");
          meta.className = "meta";
          meta.textContent = [note.course, note.y, note.topic].filter(Boolean).join(" · ");
          meta.appendChild(renderNotePinButton(note));
          body.appendChild(meta);
          if (note._snippet) {
            const snip = document.createElement("div");
            snip.className = "summary archive-snippet";
            // Browse snippets have no query to highlight; show plain text.
            snip.textContent = note._snippet;
            body.appendChild(snip);
          }
          const open = () => { if (row.dataset.noteIndex !== "") openKbNote(Number(row.dataset.noteIndex)); };
          row.appendChild(body);
          row.addEventListener("click", open);
          row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
          details.appendChild(row);
        }
        notesEl.appendChild(details);
      });
    }
  } catch (e) {
    if (notesEl) notesEl.innerHTML = `<div class="empty">Couldn't load this course (${e.message}).</div>`;
  }
}

/** Re-render whichever Browse view is showing, from the current state. */
function refreshBrowse() {
  if (kbCurrentCourse) openCourse(kbCurrentCourse);
  else loadBrowseCourses();
}

// Render a compact related-notes preview inside a search-result card.
// Reuses the same local related-note model as the detail-modal panel.
function renderRelatedPreviewError(container, retry) {
  const state = relatedPreviewSurfaceModel({ state: "error" });
  const action = relatedPreviewRetryModel();
  const attempt = (Number(container.dataset.relatedRetryAttempts) || 0) + 1;
  container.dataset.relatedRetryAttempts = String(attempt);
  const error = relatedPreviewErrorModel(attempt);
  container.hidden = !state.visible;
  container.classList.remove("is-loading");
  container.classList.add("is-error");
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-label", relatedPreviewAnnouncement("error", { count: attempt }).text);
  container.textContent = error.announcement;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kb-related-preview-retry";
  button.textContent = action.label;
  button.setAttribute("aria-label", action.ariaLabel);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    renderRelatedPreview(container, retry, { restoreFocus: true });
  });
  button.addEventListener("keydown", (event) => event.stopPropagation());
  container.appendChild(button);
}

async function renderRelatedPreview(container, noteIndex, { restoreFocus = false } = {}) {
  if (!container) return;
  const parentCard = container.closest(".kb-result-card");
  const restoreParentFocus = () => {
    if (restoreFocus && parentCard?.isConnected) parentCard.focus();
  };
  try {
    let related;
    const limit = relatedNotesLimit(loadKbSettings());
    related = localRelatedFromBundle(localKbBundle, noteIndex, { limit });
    if (!related.length) {
      const state = relatedPreviewSurfaceModel({ state: "empty" });
      container.hidden = !state.visible;
      container.classList.remove("is-loading", "is-error");
      delete container.dataset.relatedRetryAttempts;
      container.textContent = "";
      restoreParentFocus();
      return;
    }
    const state = relatedPreviewSurfaceModel({ state: "ready" });
    container.hidden = !state.visible;
    container.classList.remove("is-error");
    container.classList.toggle("is-loading", state.loading);
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-label", relatedPreviewAnnouncement("ready", {
      cached: !!localKbBundle?.notes?.length,
      count: related.length,
    }).text);
    delete container.dataset.relatedRetryAttempts;
    container.textContent = "";
    const tag = document.createElement("span");
    tag.className = "kb-related-preview-label";
    tag.textContent = "Related:";
    container.appendChild(tag);
    for (const rel of related) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kb-chip kb-related-preview-chip";
      b.title = "Open related note";
      // Only show the title in the compact chip; meta on hover via title.
      b.textContent = rel.t || "(untitled)";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation(); // don't also open the parent card
        openKbNote(rel.noteIndex);
      });
      container.appendChild(b);
    }
    restoreParentFocus();
  } catch {
    renderRelatedPreviewError(container, noteIndex);
    restoreParentFocus();
  }
}

function renderFilterChips(filters) {
  const chips = $("kbFilterChips");
  if (!chips) return;
  // Pure model: returns ALL courses + years + kinds + families (no truncation)
  // and the active selection, so every facet is reachable as a filter
  // (owner request #2 + focus area 7).
  const model = kbFilterModel(filters, {
    course: kbActiveCourse,
    year: kbActiveYear,
    kind: kbActiveKind,
    family: kbActiveFamily,
    sort: kbActiveSort,
  });
  const courses = model.courses;
  const years = model.years;
  const kinds = model.kinds;
  const families = model.families;
  if (courses.length === 0 && years.length === 0 && kinds.length === 0 && families.length === 0) {
    chips.hidden = true; chips.innerHTML = ""; return;
  }
  chips.hidden = false;
  chips.innerHTML = "";

  const makeChip = (label, kind, value, active) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kb-chip" + (active ? " active" : "");
    b.textContent = label;
    b.title = active ? `Remove filter: ${label}` : `Filter by ${label}`;
    b.addEventListener("click", () => {
      if (kind === "course") kbActiveCourse = active ? "" : value;
      else if (kind === "year") kbActiveYear = active ? "" : value;
      else if (kind === "kind") kbActiveKind = active ? "" : value;
      else if (kind === "family") kbActiveFamily = active ? "" : value;
      saveKbSearchState({ course: kbActiveCourse, year: kbActiveYear, kind: kbActiveKind, family: kbActiveFamily, sort: kbActiveSort });
      const input = $("kbSearchInput");
      runKbSearch(input ? input.value : "");
    });
    return b;
  };

  if (years.length) {
    const lbl = document.createElement("span");
    lbl.className = "kb-chip-group-label";
    lbl.textContent = "Year:";
    chips.appendChild(lbl);
    for (const y of years) chips.appendChild(makeChip(y, "year", y, model.activeYear === y));
  }
  if (courses.length) {
    const lbl = document.createElement("span");
    lbl.className = "kb-chip-group-label";
    lbl.textContent = "Course:";
    chips.appendChild(lbl);
    // Every course is rendered (no top-N cap) so none is unreachable.
    // The .kb-filter-chips container scrolls horizontally if the row is long.
    for (const c of courses) chips.appendChild(makeChip(c, "course", c, model.activeCourse === c));
  }
  // Focus area 7: Type + Class-type facets join course + year.
  if (kinds.length) {
    const lbl = document.createElement("span");
    lbl.className = "kb-chip-group-label";
    lbl.textContent = "Type:";
    chips.appendChild(lbl);
    for (const k of kinds) chips.appendChild(makeChip(k, "kind", k, model.activeKind === k));
  }
  if (families.length) {
    const lbl = document.createElement("span");
    lbl.className = "kb-chip-group-label";
    lbl.textContent = "Class type:";
    chips.appendChild(lbl);
    for (const f of families) chips.appendChild(makeChip(f, "family", f, model.activeFamily === f));
  }

  // ROADMAP #55: a "Clear filters" control appears only when a facet is active,
  // so the student can reset the course/year selection without retyping.
  if (kbActiveCourse || kbActiveYear || kbActiveKind || kbActiveFamily || kbActiveSort !== "relevance") {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "kb-chip kb-clear-filters";
    clear.textContent = "✕ Clear filters";
    clear.title = "Remove the active filters and sort";
    clear.addEventListener("click", () => {
      kbActiveCourse = "";
      kbActiveYear = "";
      kbActiveKind = "";
      kbActiveFamily = "";
      // Also reset the explicit sort so the control disappears and the dropdown
      // stays in sync (a persistent non-default sort would otherwise keep the
      // clear button visible even with no facet active).
      kbActiveSort = "relevance";
      saveKbSearchState({ course: kbActiveCourse, year: kbActiveYear, kind: kbActiveKind, family: kbActiveFamily, sort: kbActiveSort });
      const sortSel = $("kbSort");
      if (sortSel) sortSel.value = "relevance";
      const input = $("kbSearchInput");
      runKbSearch(input ? input.value : "");
    });
    chips.appendChild(clear);
  }
}

// ROADMAP #55: show "Showing N of M notes" above the results, narrowing M when
// a course/year filter is active, plus a "Clear filters" control that resets
// the active facet(s) and re-runs the search.
function renderResultCount(data, { course, year, kind = kbActiveKind, family = kbActiveFamily, sort = kbActiveSort }) {
  const el = $("kbResultCount");
  const status = $("kbFilterStatus");
  if (!el) return;
  const hidden = !data || !Array.isArray(data.results) || data.results.length === 0;
  if (hidden) {
    el.hidden = true; el.innerHTML = "";
    if (status) status.textContent = "No matching notes. " + buildFilterAnnouncement({ shown: 0, total: data?.filteredCount || data?.meta?.noteCount || 0, course, year, kind, family, sort });
    return;
  }
  el.hidden = false;
  const shown = data.results.length;
  const total = typeof data.filteredCount === "number" ? data.filteredCount : (data.meta?.noteCount ?? shown);
  el.textContent = buildResultSummary({ shown, total, course, year });
  if (status) status.textContent = buildFilterAnnouncement({ shown, total, course, year, kind, family, sort });
}

// ---------------------------------------------------------------------------
// AI Tutor (RAG over the user's local bundle)
// ---------------------------------------------------------------------------
let tutorMessages = [];
let tutorThreadTitle = "New tutor thread";

/** Normalize a browser-local tutor thread title; thread metadata never leaves the browser. */
export function tutorThreadTitleModel(value) {
  const title = typeof value === "string" ? value.trim().slice(0, 80) : "";
  return title || "New tutor thread";
}

/** Normalize bounded, browser-local archived tutor threads; never sent to the server. */
export function tutorThreadArchiveModel(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((thread) => thread && typeof thread.id === "string" && thread.id.trim())
    .slice(0, 20)
    .map((thread) => ({
      id: thread.id.trim().slice(0, 80),
      title: tutorThreadTitleModel(thread.title),
      messages: (Array.isArray(thread.messages) ? thread.messages : [])
        .filter((message) => (message?.role === "user" || message?.role === "assistant") && typeof message.content === "string" && message.content.trim())
        .slice(-40)
        .map((message) => ({ role: message.role, content: message.content.trim().slice(0, 12000) })),
      archivedAt: Number.isFinite(Number(thread.archivedAt)) ? Number(thread.archivedAt) : 0,
    }));
}

export function tutorThreadDeleteModel(value = [], id = "") {
  const cleanId = String(id || "").trim();
  return tutorThreadArchiveModel(value).filter((thread) => thread.id !== cleanId);
}

export function tutorThreadRestoreModel(value = [], id = "") {
  const cleanId = String(id || "").trim().slice(0, 80);
  return tutorThreadArchiveModel(value).find((thread) => thread.id === cleanId) || null;
}

function loadTutorThreadArchive() {
  try { return tutorThreadArchiveModel(JSON.parse(localStorage.getItem(TUTOR_THREAD_ARCHIVE_KEY) || "[]")); }
  catch { return []; }
}

function saveTutorThreadArchive(value) {
  const threads = tutorThreadArchiveModel(value);
  try { localStorage.setItem(TUTOR_THREAD_ARCHIVE_KEY, JSON.stringify(threads)); } catch {}
  return threads;
}

function renderTutorThreadArchive() {
  const list = $("kbTutorThreadArchive");
  if (!list) return;
  list.replaceChildren();
  const threads = loadTutorThreadArchive();
  list.hidden = threads.length === 0;
  for (const thread of threads) {
    const row = document.createElement("div");
    row.className = "kb-tutor-archived-thread";
    const label = document.createElement("span");
    label.textContent = thread.title;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "link-btn";
    restore.textContent = "Restore";
    restore.title = `Restore archived thread ${thread.title}`;
    restore.addEventListener("click", () => restoreTutorThread(thread.id));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link-btn";
    del.textContent = "Delete";
    del.title = `Delete archived thread ${thread.title}`;
    del.addEventListener("click", () => {
      saveTutorThreadArchive(tutorThreadDeleteModel(loadTutorThreadArchive(), thread.id));
      renderTutorThreadArchive();
    });
    row.append(label, restore, del);
    list.appendChild(row);
  }
}

function archiveCurrentTutorThread() {
  if (!tutorMessages.length) return;
  const id = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  saveTutorThreadArchive([
    { id, title: tutorThreadTitle, messages: tutorMessages, archivedAt: Date.now() },
    ...loadTutorThreadArchive(),
  ]);
  renderTutorThreadArchive();
  resetTutorUi();
}

function restoreTutorThread(id) {
  const thread = tutorThreadRestoreModel(loadTutorThreadArchive(), id);
  if (!thread) return;
  tutorMessages = thread.messages.map((message) => ({ ...message }));
  saveTutorThreadTitle(thread.title);
  const messages = $("kbTutorMessages");
  if (messages) {
    messages.replaceChildren();
    for (const message of tutorMessages) addTutorMessage(message.role, message.content, false);
  }
  const sources = $("kbTutorSources");
  if (sources) sources.innerHTML = '<span class="ai-context-note">Restored locally — answers will still use your knowledge base.</span>';
  $("kbTutorInput")?.focus();
}

function loadTutorThreadTitle() {
  try { return tutorThreadTitleModel(localStorage.getItem(TUTOR_THREAD_TITLE_KEY)); }
  catch { return tutorThreadTitleModel(); }
}

function saveTutorThreadTitle(value) {
  tutorThreadTitle = tutorThreadTitleModel(value);
  try { localStorage.setItem(TUTOR_THREAD_TITLE_KEY, tutorThreadTitle); } catch {}
  const title = $("kbTutorThreadTitle");
  if (title) title.textContent = tutorThreadTitle;
  return tutorThreadTitle;
}

/** Return a fresh thread without mutating the previous conversation. */
export function resetTutorConversation() {
  return [];
}

/** Return the latest non-empty user prompt so a failed turn can be retried. */
export function getTutorRetryPrompt(messages = []) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return "";
}

export function copyableTutorText(text) {
  return typeof text === "string" ? text.trim() : "";
}

/** Normalize the local search-context clipboard layout preference. */
export function copySearchContextFormatModel(value) {
  return value === "compact" ? "compact" : "lines";
}

/** Format the currently displayed result context without including full note bodies. */
export function copySearchContext(notes = [], { format = "lines" } = {}) {
  if (!Array.isArray(notes)) return "";
  const compact = copySearchContextFormatModel(format) === "compact";
  return notes.map((note) => {
    const title = copyableTutorText(note?.t) || "(untitled)";
    const meta = [note?.course, note?.y].filter(Boolean).join(compact ? " · " : " · ");
    const heading = meta ? `${title} — ${meta}` : title;
    const snippet = copyableTutorText(note?._snippet);
    if (!snippet) return heading;
    return compact ? `${heading} — ${snippet}` : `${heading}\n${snippet}`;
  }).join(compact ? "\n" : "\n\n");
}

/** Describe the latest local copy using metadata only; note bodies never enter this entry. */
export function copySearchContextHistoryEntryModel(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const count = Number.isInteger(input.count) && input.count > 0 ? input.count : 0;
  const query = count && typeof input.query === "string" ? input.query.trim().slice(0, 120) : "";
  const copiedAt = Number.isFinite(Number(input.copiedAt)) && Number(input.copiedAt) > 0 ? Number(input.copiedAt) : 0;
  const label = count ? `Copied ${count} result${count === 1 ? "" : "s"}${query ? ` · ${query}` : ""}` : "";
  return { count, query, copiedAt, label };
}

function loadCopySearchContextHistoryEntry() {
  try {
    const raw = JSON.parse(localStorage.getItem(KB_COPY_HISTORY_KEY) || "{}");
    return copySearchContextHistoryEntryModel(raw);
  } catch {
    return copySearchContextHistoryEntryModel();
  }
}

/** Keep only the latest browser-local copy payload and its result count. */
export function copySearchContextHistoryModel(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const count = Number.isInteger(input.count) && input.count > 0 ? input.count : 0;
  return { text: "", count };
}

/** Clear the browser-local copy payload and metadata without touching the KB bundle. */
export function copySearchContextHistoryDismissModel() {
  return { text: "", count: 0 };
}

function loadCopySearchContextHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(KB_COPY_HISTORY_KEY) || "{}");
    return { text: latestCopySearchContextText, count: copySearchContextHistoryEntryModel(raw).count };
  } catch {
    return { text: latestCopySearchContextText, count: 0 };
  }
}

function saveCopySearchContextHistory(text, count, query) {
  latestCopySearchContextText = typeof text === "string" ? text : "";
  try {
    localStorage.setItem(KB_COPY_HISTORY_KEY, JSON.stringify(copySearchContextHistoryEntryModel({ count, query, copiedAt: Date.now() })));
  } catch {}
}

export function studyModeModel(text) {
  const source = copyableTutorText(text);
  if (!source) return null;
  return {
    title: "Study mode",
    questions: [
      "What is the main idea of this answer?",
      "Which detail from this answer would you explain to a classmate?",
      "How could you apply or check this idea?",
    ],
    source,
  };
}

/** Return the latest non-empty assistant answer for local tutor actions. */
export function latestTutorAnswer(messages = []) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = copyableTutorText(message.content);
    if (text) return text;
  }
  return "";
}

export function studyModeProgressModel(completed, total) {
  const count = Number.isInteger(total) && total > 0 ? total : 0;
  const valid = Array.isArray(completed)
    ? [...new Set(completed.filter((index) => Number.isInteger(index) && index >= 0 && index < count))].sort((a, b) => a - b)
    : [];
  return {
    completed: valid,
    completedCount: valid.length,
    total: count,
    percent: count ? Math.round((valid.length / count) * 100) : 0,
  };
}

export function toggleStudyPrompt(completed, index, total) {
  const progress = studyModeProgressModel(completed, total);
  if (!Number.isInteger(index) || index < 0 || index >= progress.total) return progress.completed;
  return progress.completed.includes(index)
    ? progress.completed.filter((item) => item !== index)
    : [...progress.completed, index].sort((a, b) => a - b);
}

export function tutorSpeechModel(text, speaking = false) {
  const clean = copyableTutorText(text);
  if (!clean) return null;
  return speaking
    ? { text: clean, label: "Stop", title: "Stop reading this answer" }
    : { text: clean, label: "Read aloud", title: "Read this answer aloud" };
}

export function tutorSpeechRateModel(value) {
  const rate = Number(value);
  return Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;
}

export function formatTutorAttribution(provider, model) {
  const p = typeof provider === "string" ? provider.trim() : "";
  const m = typeof model === "string" ? model.trim() : "";
  return p && m ? `Answered by ${p} · ${m}` : "";
}

export function tutorFeedbackModel(current = {}, change) {
  if (change === undefined && current && typeof current === "object" && !Array.isArray(current) && "answerId" in current) {
    change = current;
    current = {};
  }
  const next = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  const answerId = typeof change?.answerId === "string" ? change.answerId.trim() : "";
  const rating = change?.rating;
  if (!answerId || !["up", "down"].includes(rating)) return next;
  if (next[answerId] === rating) delete next[answerId];
  else next[answerId] = rating;
  return next;
}

function tutorAnswerId(text) {
  let hash = 2166136261;
  for (const char of copyableTutorText(text)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `answer-${(hash >>> 0).toString(16)}`;
}

function loadTutorFeedback() {
  try {
    const parsed = JSON.parse(localStorage.getItem("cwa_tutor_feedback") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function saveTutorFeedback(feedback) {
  try { localStorage.setItem("cwa_tutor_feedback", JSON.stringify(feedback)); } catch {}
}

function addTutorFeedbackActions(messageEl, text) {
  if (!messageEl || !copyableTutorText(text) || messageEl.querySelector(".ai-feedback")) return;
  const answerId = tutorAnswerId(text);
  const wrap = document.createElement("span");
  wrap.className = "ai-feedback";
  wrap.title = "Rate this answer locally in this browser";
  const current = loadTutorFeedback();
  for (const [rating, label] of [["up", "Helpful"], ["down", "Not helpful"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ai-feedback-btn ai-feedback-${rating} msg-action`;
    button.textContent = rating === "up" ? "👍" : "👎";
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", current[answerId] === rating ? "true" : "false");
    button.addEventListener("click", () => {
      const next = tutorFeedbackModel(loadTutorFeedback(), { answerId, rating });
      saveTutorFeedback(next);
      for (const sibling of wrap.querySelectorAll("button")) sibling.setAttribute("aria-pressed", next[answerId] === (sibling === button ? rating : sibling.classList.contains("ai-feedback-up") ? "up" : "down") ? "true" : "false");
    });
    wrap.appendChild(button);
  }
  messageEl.appendChild(wrap);
}

function addTutorAttribution(messageEl, provider, model) {
  const text = formatTutorAttribution(provider, model);
  if (!messageEl || !text || messageEl.querySelector(".ai-attribution")) return;
  const attribution = document.createElement("span");
  attribution.className = "ai-attribution";
  attribution.textContent = text;
  attribution.title = "The provider and model selected by the tutor router for this answer";
  messageEl.appendChild(attribution);
}

function addTutorCopyAction(messageEl, text) {
  if (!messageEl || !copyableTutorText(text) || messageEl.querySelector(".ai-copy-btn")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-copy-btn msg-action";
  button.textContent = "Copy";
  button.title = "Copy this answer";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copyableTutorText(text));
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1200);
    } catch {
      button.textContent = "Copy unavailable";
    }
  });
  messageEl.appendChild(button);
}

function addTutorSpeechAction(messageEl, text) {
  if (!messageEl || !tutorSpeechModel(text) || messageEl.querySelector(".ai-speak-btn")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-speak-btn msg-action";
  let speaking = false;
  const update = () => {
    const model = tutorSpeechModel(text, speaking);
    if (!model) return;
    button.textContent = model.label;
    button.title = model.title;
    button.setAttribute("aria-label", model.title);
    button.setAttribute("aria-pressed", speaking ? "true" : "false");
  };
  const finish = () => { speaking = false; update(); };
  update();
  button.addEventListener("click", () => {
    if (typeof window === "undefined" || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") {
      button.textContent = "Voice unavailable";
      button.disabled = true;
      return;
    }
    if (speaking) {
      window.speechSynthesis.cancel();
      finish();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new window.SpeechSynthesisUtterance(copyableTutorText(text));
    utterance.rate = tutorSpeechRateModel(loadKbSettings().speechRate);
    utterance.onend = finish;
    utterance.onerror = finish;
    speaking = true;
    update();
    window.speechSynthesis.speak(utterance);
  });
  messageEl.appendChild(button);
}
function addTutorStudyAction(messageEl, text) {
  if (!messageEl || !copyableTutorText(text) || messageEl.querySelector(".ai-save-btn")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-save-btn msg-action";
  button.textContent = "Save to study list";
  button.title = "Save this answer in this browser for later review";
  button.addEventListener("click", () => {
    const before = loadStudyList();
    const after = saveStudyList(addStudyAnswer(before, text));
    button.textContent = after.length > before.length ? "Saved" : "Already saved";
    button.disabled = true;
  });
  messageEl.appendChild(button);
}

function addTutorStudyModeAction(messageEl, text) {
  const model = studyModeModel(text);
  if (!messageEl || !model || messageEl.querySelector(".ai-study-mode-btn")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-study-mode-btn msg-action";
  button.textContent = "Study mode";
  button.title = "Turn this grounded answer into three local quiz questions";
  const panel = document.createElement("div");
  panel.className = "ai-study-mode-panel";
  panel.hidden = true;
  const heading = document.createElement("strong");
  heading.textContent = model.title;
  panel.appendChild(heading);
  const progressEl = document.createElement("div");
  progressEl.className = "ai-study-progress";
  progressEl.setAttribute("role", "status");
  progressEl.setAttribute("aria-live", "polite");
  panel.appendChild(progressEl);
  const list = document.createElement("ol");
  const answerId = tutorAnswerId(text);
  let progress = loadStudyModeProgress(answerId, model.questions.length);
  const renderProgress = () => {
    progressEl.textContent = `${progress.completedCount} of ${progress.total} completed (${progress.percent}%)`;
    for (const item of list.querySelectorAll("button[data-prompt-index]")) {
      const completed = progress.completed.includes(Number(item.dataset.promptIndex));
      item.classList.toggle("completed", completed);
      item.setAttribute("aria-pressed", completed ? "true" : "false");
    }
  };
  model.questions.forEach((question, index) => {
    const item = document.createElement("li");
    const prompt = document.createElement("button");
    prompt.type = "button";
    prompt.className = "ai-study-prompt";
    prompt.dataset.promptIndex = String(index);
    prompt.textContent = question;
    prompt.addEventListener("click", () => {
      progress = studyModeProgressModel(toggleStudyPrompt(progress.completed, index, model.questions.length), model.questions.length);
      saveStudyModeProgress(answerId, progress.completed);
      renderProgress();
    });
    item.appendChild(prompt);
    list.appendChild(item);
  });
  panel.appendChild(list);
  const note = document.createElement("small");
  note.textContent = "Generated locally from the answer already on this page — no extra notes were uploaded.";
  panel.appendChild(note);
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    if (!panel.hidden) renderProgress();
  });
  button.setAttribute("aria-expanded", "false");
  messageEl.append(button, panel);
}

function addTutorRetryAction(messageEl, prompt) {
  if (!messageEl || !prompt || messageEl.querySelector(".ai-retry-btn")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-retry-btn msg-action";
  button.textContent = "Retry";
  button.title = "Retry this tutor question";
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Retrying…";
    sendTutor(prompt, { retry: true });
  });
  messageEl.appendChild(button);
}

function resetTutorUi() {
  tutorMessages = resetTutorConversation();
  saveTutorThreadTitle("New tutor thread");
  const messages = $("kbTutorMessages");
  if (messages) messages.replaceChildren();
  const sources = $("kbTutorSources");
  if (sources) sources.innerHTML = '<span class="ai-context-note">New topic — answers will still use your knowledge base.</span>';
  $("kbTutorInput")?.focus();
}

function clearTutorUi() {
  tutorMessages = resetTutorConversation();
  const messages = $("kbTutorMessages");
  if (messages) messages.replaceChildren();
  const sources = $("kbTutorSources");
  if (sources) sources.innerHTML = '<span class="ai-context-note">Chat cleared — answers will still use your knowledge base.</span>';
  $("kbTutorInput")?.focus();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function addTutorMessage(role, text, isStreaming) {
  const wrap = $("kbTutorMessages");
  if (!wrap) return;
  let el = wrap.querySelector(`[data-role="${role}"]:last-child`);
  if (!el || !isStreaming) {
    el = document.createElement("div");
    el.className = `ai-msg ai-msg-${role}`;
    el.dataset.role = role;
    el.textContent = text;
    wrap.appendChild(el);
  } else {
    el.textContent = text;
  }
  wrap.scrollTop = wrap.scrollHeight;
  return el;
}

function preferredTutorLanguage() {
  try {
    const prefs = JSON.parse(localStorage.getItem("cwa_display_prefs") || "{}");
    return prefs?.language === "sk" ? "sk" : "en";
  } catch { return "en"; }
}

async function sendTutor(text, { retry = false } = {}) {
  const input = $("kbTutorInput");
  if (input) input.value = "";
  if (!retry) {
    tutorMessages.push({ role: "user", content: text });
    addTutorMessage("user", text);
  }
  const sourcesEl = $("kbTutorSources");
  if (sourcesEl) sourcesEl.innerHTML = `<span class="ai-context-note">Thinking… (searching the knowledge base)</span>`;

  const assistantEl = addTutorMessage("assistant", "…", true);
  let acc = "";
  try {
    const retrieved = tutorRequestNotesModel(buildTutorRetrievedNotes(localKbBundle, text));
    const r = await fetch("/api/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: currentAccessToken() ? `Bearer ${currentAccessToken()}` : "" },
      body: JSON.stringify({ messages: tutorMessages, notes: retrieved, language: preferredTutorLanguage() }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      acc = `❌ ${err.error || err.message || r.status}`;
      if (assistantEl) {
        assistantEl.textContent = acc;
        addTutorRetryAction(assistantEl, getTutorRetryPrompt(tutorMessages));
      }
      return;
    }
    const notesUsed = Number(r.headers.get("X-KB-Notes") || "0");
    const provider = r.headers.get("X-AI-Provider") || "";
    const model = r.headers.get("X-AI-Model") || "";
    // Feature: expose WHICH notes the tutor grounded on, as clickable chips
    // that jump to the full note (openKbNote). The server returns them as a
    // JSON line on a dedicated stream event so the UI can render them once.
    let sources = [];
    if (sourcesEl) {
      sourcesEl.innerHTML = notesUsed > 0
        ? `<span class="ai-context-note">📚 Grounded in ${notesUsed} note${notesUsed === 1 ? "" : "s"} from the knowledge base</span>`
        : `<span class="ai-context-note">⚠️ No matching notes found — answer may be limited</span>`;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      // SSE: lines like "data: {...}" — accumulate the content deltas.
      for (const line of chunk.split("\n")) {
        const m = line.match(/^data:\s*(.*)$/);
        if (!m) continue;
        const payload = m[1].trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          // A control event from the tutor route: sources used for grounding.
          if (j && j.type === "sources") { sources = Array.isArray(j.notes) ? j.notes : []; continue; }
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) { acc += delta; if (assistantEl) assistantEl.textContent = acc; }
        } catch {}
      }
    }
    // After streaming, render the source chips (clickable -> open the note).
    renderTutorSources(sourcesEl, sources);
    addTutorCopyAction(assistantEl, acc);
    addTutorSpeechAction(assistantEl, acc);
    addTutorStudyAction(assistantEl, acc);
    addTutorStudyModeAction(assistantEl, acc);
    addTutorFeedbackActions(assistantEl, acc);
    addTutorAttribution(assistantEl, provider, model);
    tutorMessages.push({ role: "assistant", content: acc });
  } catch (e) {
    if (assistantEl) {
      assistantEl.textContent = `❌ ${e.message}`;
      addTutorRetryAction(assistantEl, getTutorRetryPrompt(tutorMessages));
    }
  }
}

function renderTutorSources(container, notes) {
  if (!container) return;
  const chips = tutorSourceList(notes);
  if (!chips.length) return; // nothing to attribute
  // Keep the "grounded in N notes" note, then append clickable chips.
  const wrap = document.createElement("div");
  wrap.className = "kb-source-chips";
  const lbl = document.createElement("span");
  lbl.className = "kb-source-chips-label";
  lbl.textContent = "Sources used:";
  wrap.appendChild(lbl);
  for (const c of chips) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kb-chip kb-source-chip";
    b.title = "Open this note";
    b.innerHTML = `<span class="kb-chip-title"></span><span class="kb-chip-sub"></span>`;
    b.querySelector(".kb-chip-title").textContent = c.title;
    if (c.subtitle) b.querySelector(".kb-chip-sub").textContent = c.subtitle;
    b.addEventListener("click", () => openKbNote(c.noteIndex));
    wrap.appendChild(b);
  }
  container.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Note-detail modal — open a full note by its index in the private bundle.
// ---------------------------------------------------------------------------
async function openKbNote(index) {
  const modal = $("kbNoteModal");
  const titleEl = $("kbNoteTitle");
  const metaEl = $("kbNoteMeta");
  const bodyEl = $("kbNoteBody");
  const linkEl = $("kbNoteOpenLink");      // PRIMARY universal-open action
  const obsLink = $("kbNoteObsidianLink"); // SECONDARY obsidian opt-in
  if (!modal || !bodyEl) return;
  noteModalOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  bodyEl.innerHTML = `<div class="empty">Loading…</div>`;
  if (metaEl) metaEl.textContent = "";
  if (titleEl) titleEl.textContent = "Loading…";
  if (linkEl) linkEl.hidden = true;
  if (obsLink) obsLink.hidden = true;
  modal.hidden = false;
  try {
    let note;
    note = localNoteFromBundle(localKbBundle, index);
    if (!note) throw new Error("note not found in local knowledge base");
    if (titleEl) titleEl.textContent = note.t || "(untitled)";
    announceNoteModal("open", note.t || "(untitled)");
    if (metaEl) metaEl.textContent = [note.course, note.y, note.topic].filter(Boolean).join("  ·  ");
    if (metaEl) {
      metaEl.replaceChildren(document.createTextNode([note.course, note.y, note.topic].filter(Boolean).join("  ·  ")));
      metaEl.appendChild(renderNotePinButton(note));
    }
    markNoteProgress(index);
    // Prefer the full body, fall back to summary. renderLightMarkdown escapes
    // HTML and turns markdown links ([text](url)) into clickable <a> tags, so
    // teacher materials + student submission links are actually clickable.
    const fullText = (note.x || note.s || "").trim();
    if (fullText) {
      bodyEl.innerHTML = renderLightMarkdown(fullText);
    } else {
      bodyEl.innerHTML = `<div class="empty">This note has no body text.</div>`;
    }
    // ROADMAP §Reported #5: a UNIVERSAL external-open. Resolve the most useful
    // primary action (real source URL -> "Open original"; else a vault/local
    // path -> "Download note (.md)"). Obsidian is a secondary, clearly-labelled
    // opt-in shown only when a local path exists — never the lone action.
    const openAction = resolveNoteOpenAction(note);
    if (linkEl) {
      if (openAction.kind === "external") {
        linkEl.textContent = openAction.label;
        linkEl.href = openAction.href;
        linkEl.target = "_blank";
        linkEl.rel = "noopener";
        linkEl.hidden = false;
      } else if (openAction.kind === "download") {
        linkEl.textContent = openAction.label;
        linkEl.removeAttribute("href");
        linkEl.onclick = (e) => { e.preventDefault(); downloadNoteAsMarkdown(note); };
        linkEl.hidden = false;
      } else {
        linkEl.hidden = true;
      }
    }
    // Secondary Obsidian deep-link (opt-in only) when a local path exists.
    if (obsLink) {
      if (note.p) {
        obsLink.href = "obsidian://open?path=" + encodeURIComponent(note.p);
        obsLink.textContent = "Open in Obsidian";
        obsLink.hidden = false;
      } else {
        obsLink.hidden = true;
      }
    }
    // Feature A: cross-link related notes.
    await renderRelatedNotes(index);
  } catch (e) {
    announceNoteModal("error");
    bodyEl.innerHTML = `<div class="empty">Failed to load note: ${e.message}</div>`;
  }
}

async function renderRelatedNotes(index) {
  const wrap = $("kbNoteRelated");
  const list = $("kbNoteRelatedList");
  if (!wrap || !list) return;
  wrap.hidden = true;
  list.innerHTML = "";
  try {
    let related;
    const limit = relatedNotesLimit(loadKbSettings());
    related = localRelatedFromBundle(localKbBundle, index, { limit });
    // owner #6: cap the rendered panel to 3 items so it stays compact.
    related = related.slice(0, 3);
    if (!related.length) return;
    for (const rel of related) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "kb-related-item";
      const title = document.createElement("span");
      title.className = "kb-related-item-title";
      title.textContent = rel.t || "(untitled)";
      item.appendChild(title);
      const meta = document.createElement("span");
      meta.className = "kb-related-item-meta";
      meta.textContent = [rel.course, rel.y].filter(Boolean).join(" · ");
      item.appendChild(meta);
      item.addEventListener("click", () => openKbNote(rel.noteIndex));
      list.appendChild(item);
    }
    wrap.hidden = false;
  } catch (e) { /* related panel is non-critical; ignore */ }
}

function closeKbNote() {
  const modal = $("kbNoteModal");
  if (modal) modal.hidden = true;
  announceNoteModal("close");
  const origin = noteModalOrigin;
  noteModalOrigin = null;
  if (origin && origin.isConnected && noteModalFocusTargetModel({ origin: origin.id, connected: true })) {
    origin.focus();
  }
}

// ---------------------------------------------------------------------------
// Universal note "open" action (ROADMAP §Reported #5).
//
// The old UI offered ONLY an Obsidian deep link (obsidian://open?path=...).
// For the school-backup vault notes — which carry a LOCAL filesystem path `p`
// but no web URL — that link points at a file the student can't reach and
// demands Obsidian. This resolver picks the most useful primary action:
//   - a real http(s) source URL  -> "Open original" (new tab)
//   - else a local/vault path `p`  -> "Download note (.md)" (client-side)
//   - else nothing to open         -> { kind: "none" }
// Obsidian stays available only as a SECONDARY, clearly-labelled opt-in for
// users who have it (never the default for a vault note). Pure (no DOM), so it
// is unit-testable and shared by the detail-modal renderer.
// ---------------------------------------------------------------------------
export function resolveNoteOpenAction(note) {
  const url = note && (note.sourceUrl || note.url);
  if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) {
    return { kind: "external", label: "Open original", href: url.trim() };
  }
  const p = note && note.p;
  if (typeof p === "string" && p.trim()) {
    return { kind: "download", label: "Download note (.md)", path: p.trim() };
  }
  return { kind: "none" };
}

// Allow Esc / backdrop click to close both KB modals.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const nm = $("kbNoteModal");
      const tm = $("kbTutorModal");
      if (nm && !nm.hidden) closeKbNote();
      if (tm && !tm.hidden) tm.hidden = true;
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("modal")) {
      if (e.target.id === "kbNoteModal") closeKbNote();
      else e.target.hidden = true;
    }
  });
}

// Auto-wire once the DOM is ready, independent of Google Identity Services.
// (app.js also calls wireKbEvents() after GIS loads; the idempotent guard
//  prevents double-binding. This makes the KB usable even if GIS is blocked.)
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => wireKbEvents());
  } else {
    wireKbEvents();
  }
}
