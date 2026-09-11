// prefs-sync-local.js — the bridge between localStorage and the synced document.
//
// prefs-sync.js decides how two devices' data combine. This decides what goes
// in, what comes out, and where it lives on this device.
//
// The one design choice worth explaining is how removals are noticed. A
// tombstone needs to know that you unpinned something, and the code that
// unpins just writes a shorter array — there is no event to listen to. The
// obvious fix is to call a "record this deletion" hook at all ten save sites in
// app.js and kb.js. The obvious fix is also how you get a site that forgets,
// and a pin that rises from the grave months later.
//
// So nothing is hooked. At sync time the journal is DIFFED against whatever the
// arrays actually say, and every difference — added or removed, by any code
// path, including ones written after this file — is stamped then. It cannot be
// bypassed because it does not depend on being called.
//
// The price is honest and small: a change is stamped when it syncs, not when it
// happened. Unpin on a laptop that then stays shut for a week while your phone
// re-pins the same item on day three, and the laptop's removal still wins when
// it finally reconnects. That is one pin, recoverable by pinning it again, in
// exchange for never silently missing a deletion.

import {
  mergeSyncedPrefs, trackChanges, trackedIds, trackedRecords, TRACKED_SECTIONS,
} from "./prefs-sync.js";

// The single source of truth for these names. app.js and kb.js import them
// from here rather than each declaring their own copy of the string.
export const STORAGE_KEYS = {
  pinned: "cwa_pinned",
  dismissed: "cwa_dismissed",
  pinnedCourses: "cwa_kb_pinned_courses",
  pinnedNotes: "cwa_kb_pinned_notes",
  studyList: "cwa_tutor_study_list",
  studyActivity: "cwa_kb_study_activity",
  noteProgress: "cwa_kb_note_progress",
  kbSettings: "cwa_kb_settings",
  display: "cwa_display_prefs",
  hiddenCourses: "cwa_hidden_courses",
};

/** The tombstone journal. Never rendered; it exists only to survive a merge. */
const TRACKED_KEY = "cwa_sync_tracked";

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/**
 * How each tracked section reads its live list out of localStorage, and how a
 * merged one is written back. `ids` is the identity the tombstones key on.
 */
const TRACKED_SHAPES = {
  pinned: { idsOnly: true },
  dismissed: { idsOnly: true },
  pinnedCourses: { idsOnly: true },
  pinnedNotes: { idsOnly: false, fields: ["title"] },
  studyList: { idsOnly: false, fields: ["text", "savedAt"] },
};

function liveList(section) {
  const value = readJson(STORAGE_KEYS[section], []);
  return Array.isArray(value) ? value : [];
}

/**
 * Reconcile the journal against what the arrays actually hold, and persist it.
 *
 * This is the function that makes hookless tracking work. Called before every
 * push, so any change made since the last one — however it was made — is on the
 * record by the time the server sees it.
 */
export function reconcileTracked(now = Date.now()) {
  const journal = readJson(TRACKED_KEY, {}) || {};
  const next = {};
  for (const [section, shape] of Object.entries(TRACKED_SHAPES)) {
    const list = liveList(section);
    const fields = shape.fields || [];
    let ids;
    let payloads = null;
    if (shape.idsOnly) {
      ids = list.map((id) => String(id || "").trim()).filter(Boolean);
    } else {
      ids = [];
      payloads = {};
      for (const item of list) {
        const id = String(item?.id || "").trim();
        if (!id) continue;
        ids.push(id);
        payloads[id] = item;
      }
    }
    next[section] = trackChanges(journal[section], ids, { now, payloads, fields });
  }
  writeJson(TRACKED_KEY, next);
  return next;
}

/** This device's view, in the shape /api/prefs merges. */
export function readLocalPrefsDoc(now = Date.now()) {
  const tracked = reconcileTracked(now);
  const doc = {
    studyActivity: readJson(STORAGE_KEYS.studyActivity, []),
    noteProgress: readJson(STORAGE_KEYS.noteProgress, {}),
    kbSettings: readJson(STORAGE_KEYS.kbSettings, null),
    display: readJson(STORAGE_KEYS.display, null),
  };
  for (const section of Object.keys(TRACKED_SHAPES)) doc[section] = tracked[section];
  // Hidden courses keep their existing wire name and their existing rule.
  const hidden = readJson(STORAGE_KEYS.hiddenCourses, null);
  if (Array.isArray(hidden)) doc.hiddenCourseIds = hidden;
  for (const key of ["kbSettings", "display"]) if (!doc[key]) delete doc[key];
  return doc;
}

/**
 * Write a merged document back into the local stores.
 *
 * The journal is written from the merged tracked maps in the same pass, so the
 * next reconcile sees agreement rather than reading the newly-applied values as
 * fresh local edits and re-stamping them.
 */
export function applySyncedPrefs(merged, now = Date.now()) {
  if (!merged || typeof merged !== "object") return null;
  const journal = {};
  for (const [section, shape] of Object.entries(TRACKED_SHAPES)) {
    const tracked = merged[section] || {};
    journal[section] = tracked;
    const value = shape.idsOnly
      ? trackedIds(tracked, { now })
      : trackedRecords(tracked, { now, fields: shape.fields || [] });
    writeJson(STORAGE_KEYS[section], value);
  }
  writeJson(TRACKED_KEY, journal);

  if (Array.isArray(merged.studyActivity)) writeJson(STORAGE_KEYS.studyActivity, merged.studyActivity);
  if (merged.noteProgress && typeof merged.noteProgress === "object") {
    writeJson(STORAGE_KEYS.noteProgress, merged.noteProgress);
  }
  if (merged.kbSettings && typeof merged.kbSettings === "object") {
    writeJson(STORAGE_KEYS.kbSettings, merged.kbSettings);
  }
  if (merged.display && typeof merged.display === "object") {
    writeJson(STORAGE_KEYS.display, merged.display);
  }
  if (Array.isArray(merged.hiddenCourseIds)) {
    writeJson(STORAGE_KEYS.hiddenCourses, merged.hiddenCourseIds);
  }
  return merged;
}

/**
 * Merge locally without a server — the offline path.
 *
 * Used when the push fails, so a device that has been offline still converges
 * its own journal rather than accumulating an ever-larger unsynced diff.
 */
export function mergeLocally(remote, now = Date.now()) {
  return applySyncedPrefs(mergeSyncedPrefs(readLocalPrefsDoc(now), remote, { now }), now);
}

export { TRACKED_SECTIONS };
