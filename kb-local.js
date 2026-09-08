// kb-local.js — private, browser-local Knowledge Base persistence.
//
// Reuses archive.js's IndexedDB primitives and database instead of creating a
// second storage layer. The KB remains a distinct bundle under its own record
// IDs, so it cannot overwrite the raw Classroom archive.

import { idbGet, idbPut, idbDelete } from "./archive.js";
import { makeSortFn } from "./kb-client-search.js";
import { kbBuildCheckpointModel, isStaleKbBuildCheckpoint } from "./kb-local-status.js";
import { noteProgressKey } from "./study-progress.js";
import { mergeBundles } from "./kb-merge.js";

const BUNDLE_ID = "kb-bundle";
const META_ID = "kb-meta";
const BUILD_CHECKPOINT_ID = "kb-build-checkpoint";

/** Validate the small public contract shared by KB ingestion and local storage. */
export function validateKbBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("KB bundle object required");
  }
  if (bundle.version !== 1) throw new Error("Unsupported KB bundle version 1 expected");
  if (!Array.isArray(bundle.notes)) throw new Error("KB bundle is missing its notes array");
  return bundle;
}

/**
 * Save a validated KB bundle to the user's existing browser-local store.
 *
 * One record. The old `kb-meta` companion held noteCount, years and
 * generatedAt — every field of it derivable from the bundle sitting next to it,
 * and nothing ever read it back: the stat bar builds its numbers from
 * `browseKbBundle(...).meta`, computed from the notes. It was a second write on
 * every save of a copy that could go stale against the thing it described.
 * `removeKbBundle` still deletes it, so browsers carrying one shed it.
 */
export async function saveKbBundle(bundle) {
  const valid = validateKbBundle(bundle);
  await idbPut({ id: BUNDLE_ID, data: valid });
  return valid;
}

/**
 * Fold a freshly ingested bundle into whatever is already stored.
 *
 * Every ingestion path used saveKbBundle directly, which REPLACES — so
 * rebuilding from Classroom discarded an imported archive of past years, and
 * importing an archive discarded the build. One corpus means accumulating.
 */
export async function saveMergedKbBundle(incoming) {
  const existing = await loadKbBundle().catch(() => null);
  return saveKbBundle(mergeBundles(existing, incoming));
}

/** Return the distinct years represented by one course, newest first. */
export function browseYearFacet(bundle, course = "") {
  const cleanCourse = String(course || "").trim();
  const years = new Set(
    (Array.isArray(bundle?.notes) ? bundle.notes : [])
      .filter((note) => !cleanCourse || (note?.course || "Uncategorised") === cleanCourse)
      .map((note) => String(note?.y || "").trim())
      .filter(Boolean),
  );
  return [...years].sort((a, b) => {
    const undated = (value) => value.toLowerCase() === "undated";
    return (undated(a) ? 1 : 0) - (undated(b) ? 1 : 0) || b.localeCompare(a);
  });
}

/** Build the no-network browse response for the user's local bundle. */
function isRecentlyStudied(progress, note, today, recentDays) {
  if (!Number.isInteger(recentDays) || recentDays < 1) return true;
  const key = noteProgressKey(note);
  const opened = key ? String(progress?.[key]?.lastOpened || "") : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opened) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
  const delta = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${opened}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(delta) && delta >= 0 && delta < recentDays;
}

/** Distinct class-type families across the corpus, alphabetically. */
export function browseFamilyFacet(bundle) {
  const families = new Set(
    (Array.isArray(bundle?.notes) ? bundle.notes : [])
      .map((note) => String(note?.family || "").trim())
      .filter(Boolean),
  );
  return [...families].sort((a, b) => a.localeCompare(b));
}

/** Distinct topics within one course (optionally within one year), alphabetically. */
export function browseTopicFacet(bundle, course = "", year = "") {
  const cleanCourse = String(course || "").trim();
  const cleanYear = String(year || "").trim();
  const topics = new Set(
    (Array.isArray(bundle?.notes) ? bundle.notes : [])
      .filter((note) => (!cleanCourse || (note?.course || "Uncategorised") === cleanCourse))
      .filter((note) => (!cleanYear || (note?.y || "") === cleanYear))
      .map((note) => String(note?.topic || "").trim())
      .filter(Boolean),
  );
  return [...topics].sort((a, b) => a.localeCompare(b));
}

export const BROWSE_COURSE_SORTS = ["notes", "alpha", "recent"];

/**
 * Sort the course grid.
 *
 * "recent" is newest year first — the courses you are actually taking — which
 * the fixed count-descending order buried under whichever old class happened
 * to have the most notes.
 */
export function sortBrowseCourses(courses, sort = "notes") {
  const key = BROWSE_COURSE_SORTS.includes(sort) ? sort : "notes";
  const latest = (c) => (Array.isArray(c.years) && c.years.length ? c.years[c.years.length - 1] : "");
  return [...courses].sort((a, b) => {
    if (key === "alpha") return a.course.localeCompare(b.course);
    if (key === "recent") return latest(b).localeCompare(latest(a)) || b.count - a.count || a.course.localeCompare(b.course);
    return b.count - a.count || a.course.localeCompare(b.course);
  });
}

export function browseKbBundle(bundle, course = "", { year = "", kind = "", family = "", topic = "", sort = "recency", courseSort = "notes", progress = null, today = "", recentDays = 0 } = {}) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const cleanCourse = String(course || "").trim();
  const cleanYear = String(year || "").trim();
  const cleanKind = String(kind || "").trim();
  const cleanFamily = String(family || "").trim();
  const cleanTopic = String(topic || "").trim();
  const cleanToday = String(today || "").trim();
  const sortKey = new Set(["relevance", "recency", "course", "title"]).has(sort) ? sort : "recency";
  const browseSnippet = (note) => {
    const source = String(note?.s || note?.x || "").trim();
    return source.length > 200 ? `${source.slice(0, 200)}…` : source;
  };
  const meta = {
    noteCount: notes.length,
    years: Array.isArray(bundle?.years) ? bundle.years : [...new Set(notes.map((note) => note?.y).filter(Boolean))].sort(),
    generatedAt: bundle?.generatedAt || null,
    updatedAt: bundle?.generatedAt || null,
  };
  // Index alongside the note rather than looking it back up: `notes.indexOf`
  // inside this filter made scoping quadratic, and the note index is also what
  // the result cards need to open a note.
  const scopedNotes = notes
    .map((note, noteIndex) => ({ note, noteIndex }))
    .filter(({ note }) =>
      (!cleanCourse || (note?.course || "Uncategorised") === cleanCourse) &&
      (!cleanYear || (note?.y || "") === cleanYear) &&
      (!cleanKind || (note?.kind || "") === cleanKind) &&
      (!cleanFamily || (note?.family || "") === cleanFamily) &&
      (!cleanTopic || (note?.topic || "") === cleanTopic) &&
      isRecentlyStudied(progress, note, cleanToday, recentDays)
    );
  if (cleanCourse) {
    return {
      meta,
      notes: scopedNotes
        .map(({ note, noteIndex }) => ({
          t: note?.t || "",
          course: note?.course || "",
          y: note?.y || "",
          topic: note?.topic || null,
          kind: note?.kind || "",
          family: note?.family || "",
          p: note?.p || "",
          noteIndex,
          _score: 0,
          _snippet: browseSnippet(note),
        }))
        .sort(makeSortFn(sortKey)),
    };
  }
  const map = new Map();
  scopedNotes.forEach(({ note }) => {
    const name = note?.course || "Uncategorised";
    const entry = map.get(name) || { course: name, count: 0, years: new Set() };
    entry.count += 1;
    if (note?.y) entry.years.add(note.y);
    map.set(name, entry);
  });
  return {
    meta,
    courses: sortBrowseCourses(
      [...map.values()].map((entry) => ({ ...entry, years: [...entry.years].sort() })),
      courseSort,
    ),
  };
}

export async function loadKbBundle() {
  const localHarness = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const testDelay = localHarness ? Number(window.__cwaTestLoadDelayMs) : 0;
  if (Number.isFinite(testDelay) && testDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(testDelay, 5000)));
  }
  const record = await idbGet(BUNDLE_ID);
  return record?.data ? validateKbBundle(record.data) : null;
}

/** Remove only the local KB records; the raw archive remains untouched. */
export async function removeKbBundle() {
  await idbDelete(BUNDLE_ID);
  await idbDelete(META_ID);
}

/** Persist only a normalized, resumable Classroom checkpoint; never persist OAuth tokens. */
export async function saveKbBuildCheckpoint(checkpoint) {
  const safe = kbBuildCheckpointModel(checkpoint);
  // `savedAt` is record metadata, not part of the normalized checkpoint the
  // resume logic reads, so it lives on the wrapper.
  await idbPut({ id: BUILD_CHECKPOINT_ID, data: safe, savedAt: new Date().toISOString() });
  return safe;
}

/**
 * The resumable checkpoint, or null.
 *
 * An expired one is DELETED here rather than merely ignored: it is the largest
 * thing this database stores after the corpus itself, and an abandoned build
 * would otherwise keep a stale copy of most of Classroom forever.
 */
export async function loadKbBuildCheckpoint() {
  const record = await idbGet(BUILD_CHECKPOINT_ID);
  if (!record?.data) return null;
  if (isStaleKbBuildCheckpoint(record.savedAt)) {
    await idbDelete(BUILD_CHECKPOINT_ID).catch(() => {});
    return null;
  }
  return record.data;
}

export async function removeKbBuildCheckpoint() {
  await idbDelete(BUILD_CHECKPOINT_ID);
}
