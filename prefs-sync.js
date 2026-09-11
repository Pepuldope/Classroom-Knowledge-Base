// prefs-sync.js — how two devices' preferences become one.
//
// /api/prefs has always been last-write-wins over the whole document: kvSet
// replaces the blob, syncPrefsFromServer replaces local state. That is fine for
// the two things it carried (hidden courses, display prefs) because you change
// those deliberately, rarely, on one device at a time. It is silent data loss
// for anything that ACCUMULATES — study on your phone, open the laptop, the
// laptop pushes its older copy and the phone's work is gone. A sync that eats
// data is worse than no sync, because it looks like it works.
//
// So everything here merges rather than replaces, and the merge rules are
// chosen per section by how the data behaves:
//
//   streak      a set of dates that only ever grows      -> union
//   progress    a counter and a high-water date per note -> max / later
//   pins etc.   sets you add to AND remove from          -> per-id last-write-
//                                                           wins with tombstones
//
// The first two are commutative, associative and idempotent: merge(a,b) equals
// merge(b,a), and merging twice changes nothing. That is not a nicety, it is
// what lets the server read-modify-write without a lock. Two devices racing
// produce the same answer in either order, and a lost update is repaired by the
// next sync instead of being permanent.
//
// The third is not conflict-free, and pretending otherwise is the bug everyone
// ships first: with a plain union, unpinning on your laptop loses to your
// phone's stale copy and the pin comes back from the dead. Removals have to be
// recorded as facts with a time on them, which is what a tombstone is.

// Bounds. Every one of these exists so a synced blob cannot grow without limit
// against Upstash's ~1MB per-value ceiling, which is the same ceiling that made
// kb-store.js shard at 400 notes.
export const MAX_PROGRESS_KEY = 400;   // matches noteProgressKey's own cap
export const MAX_PROGRESS_ENTRIES = 5000;
export const MAX_DATES = 1500;         // ~4 school years of streak
export const MAX_TRACKED = 500;        // per set: pins, dismissed, study list
export const MAX_FIELD = 400;
/**
 * How long a deletion is remembered.
 *
 * A tombstone has to outlive every device that might still be holding the
 * deleted item, or that device re-adds it on its next sync. It cannot live
 * forever or the blob only grows. Ninety days is the trade: a phone that has
 * been offline since before then may resurrect one pin, which is a great deal
 * better than every deletion you have ever made being stored for all time.
 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (value, max = MAX_FIELD) =>
  (typeof value === "string" ? value.trim().slice(0, max) : "");

const ms = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// ---------------------------------------------------------------------------
// Grow-only: the study streak.
// ---------------------------------------------------------------------------

/**
 * Union of two date sets, sorted, newest kept when capped.
 *
 * Studying is a fact that happened. Neither device can un-know a day the other
 * one recorded, so there is no conflict to resolve — only two partial views of
 * the same history. The cap drops the OLDEST dates because a streak is read
 * from the recent end.
 */
export function mergeDateSet(a, b) {
  const out = new Set();
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const value of list) if (DATE_RE.test(value)) out.add(value);
  }
  return [...out].sort().slice(-MAX_DATES);
}

// ---------------------------------------------------------------------------
// High-water marks: per-note study progress.
// ---------------------------------------------------------------------------

/**
 * Merge `{ [notePath]: { opened, lastOpened } }`.
 *
 * `opened` takes the MAX, not the sum. Summing looks more correct — you really
 * did open it three times here and twice there — but merging is not a one-off
 * event: the same two records are merged on every sync, so a sum would inflate
 * the count every time the devices talked. Max is idempotent, which is the
 * property that matters more than precision in a counter nobody audits.
 *
 * Keyed by note path, which study-progress.js deliberately made stable after
 * array indices were found to re-point at different notes when a bundle merged.
 */
export function mergeNoteProgress(a, b) {
  const out = {};
  const take = (source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    for (const [rawKey, entry] of Object.entries(source)) {
      const key = str(rawKey, MAX_PROGRESS_KEY);
      if (!key || !entry || typeof entry !== "object") continue;
      const opened = Math.max(0, Math.floor(Number(entry.opened) || 0));
      const lastOpened = DATE_RE.test(entry.lastOpened || "") ? entry.lastOpened : null;
      if (!opened && !lastOpened) continue;
      const prev = out[key];
      out[key] = {
        opened: Math.max(opened, prev?.opened || 0),
        // Dates are ISO, so a string compare is a date compare.
        lastOpened: [lastOpened, prev?.lastOpened].filter(Boolean).sort().at(-1) || null,
      };
    }
  };
  take(a);
  take(b);
  const entries = Object.entries(out).map(([key, value]) => [
    key,
    value.lastOpened ? { opened: value.opened, lastOpened: value.lastOpened } : { opened: value.opened },
  ]);
  // Over the cap, keep what was studied most recently; an entry with no date
  // sorts last and is dropped first.
  if (entries.length > MAX_PROGRESS_ENTRIES) {
    entries.sort((x, y) => String(y[1].lastOpened || "").localeCompare(String(x[1].lastOpened || "")));
    entries.length = MAX_PROGRESS_ENTRIES;
  }
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Tracked sets: things you add to and remove from.
// ---------------------------------------------------------------------------
//
// Wire shape, per id:   { at: <ms>, ...payload }   present
//                       { at: <ms>, d: 1 }         deleted
//
// The local shapes (a plain array of ids, or of {id,title} records) are NOT
// changed — every read site in app.js and kb.js keeps working untouched, and
// nobody's stored data needs migrating. The tombstones live alongside, and are
// derived by diffing at each save.

/** Normalize one tracked map, dropping junk and expired tombstones. */
export function trackedModel(value, { now = Date.now(), fields = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [rawId, entry] of Object.entries(value)) {
    const id = str(rawId, 240);
    if (!id || !entry || typeof entry !== "object") continue;
    const at = ms(entry.at);
    if (!at) continue;
    if (entry.d) {
      // Expired tombstones are forgotten; see TOMBSTONE_TTL_MS.
      if (now - at > TOMBSTONE_TTL_MS) continue;
      out[id] = { at, d: 1 };
      continue;
    }
    const record = { at };
    for (const field of fields) {
      if (field === "savedAt") {
        const n = ms(entry.savedAt);
        if (n) record.savedAt = n;
      } else {
        const text = str(entry[field]);
        if (text) record[field] = text;
      }
    }
    out[id] = record;
  }
  return capTracked(out);
}

/**
 * Over the cap, keep the most recently touched — and drop tombstones before
 * live entries, since losing a tombstone only risks resurrecting one item while
 * losing a live entry deletes something the user can see.
 */
function capTracked(map) {
  const entries = Object.entries(map);
  if (entries.length <= MAX_TRACKED) return map;
  entries.sort((a, b) => (Number(!!a[1].d) - Number(!!b[1].d)) || (b[1].at - a[1].at));
  return Object.fromEntries(entries.slice(0, MAX_TRACKED));
}

/**
 * Merge two tracked maps: for each id, the later stamp wins.
 *
 * A tie goes to the deletion. Two devices acting on the same id in the same
 * millisecond is vanishingly rare, but the rule has to be deterministic or the
 * two devices disagree forever — and of the two possible answers, "stays
 * deleted" is the one the user can undo by pinning it again.
 */
export function mergeTracked(a, b, { now = Date.now(), fields = [] } = {}) {
  const left = trackedModel(a, { now, fields });
  const right = trackedModel(b, { now, fields });
  const out = { ...left };
  for (const [id, entry] of Object.entries(right)) {
    const prev = out[id];
    if (!prev || entry.at > prev.at || (entry.at === prev.at && entry.d)) out[id] = entry;
  }
  return capTracked(out);
}

/**
 * Record what changed between the tracked map and the list actually on screen.
 *
 * This is the hook at each save site. It is a diff rather than an explicit
 * "deleted(id)" call because the code that removes a pin already just writes a
 * shorter array — asking every one of those sites to also announce the removal
 * is how you get a site that forgets, and a pin that rises from the grave.
 *
 * `now` stamps only what genuinely changed, so re-saving an unchanged list is a
 * no-op and does not churn the blob or win races it should lose.
 */
export function trackChanges(tracked, ids, { now = Date.now(), payloads = null, fields = [] } = {}) {
  const current = trackedModel(tracked, { now, fields });
  const live = new Set((Array.isArray(ids) ? ids : []).map((id) => str(id, 240)).filter(Boolean));
  const out = { ...current };
  for (const id of live) {
    const prev = current[id];
    const payload = payloads?.[id] || null;
    // Already present and unchanged: leave the original stamp alone.
    if (prev && !prev.d && !payloadDiffers(prev, payload, fields)) continue;
    out[id] = { at: now, ...cleanPayload(payload, fields) };
  }
  for (const [id, entry] of Object.entries(current)) {
    if (entry.d || live.has(id)) continue;
    out[id] = { at: now, d: 1 };
  }
  return capTracked(out);
}

function cleanPayload(payload, fields) {
  const out = {};
  if (!payload || typeof payload !== "object") return out;
  for (const field of fields) {
    if (field === "savedAt") {
      const n = ms(payload.savedAt);
      if (n) out.savedAt = n;
    } else {
      const text = str(payload[field]);
      if (text) out[field] = text;
    }
  }
  return out;
}

function payloadDiffers(entry, payload, fields) {
  const next = cleanPayload(payload, fields);
  for (const field of fields) {
    if ((entry[field] ?? "") !== (next[field] ?? "")) return true;
  }
  return false;
}

/** The live ids of a tracked map, newest first — the order pins are shown in. */
export function trackedIds(tracked, { now = Date.now() } = {}) {
  return Object.entries(trackedModel(tracked, { now }))
    .filter(([, entry]) => !entry.d)
    .sort((a, b) => a[1].at - b[1].at)
    .map(([id]) => id);
}

/** The live records of a tracked map, in the same order, with their payloads. */
export function trackedRecords(tracked, { now = Date.now(), fields = [] } = {}) {
  return Object.entries(trackedModel(tracked, { now, fields }))
    .filter(([, entry]) => !entry.d)
    .sort((a, b) => a[1].at - b[1].at)
    .map(([id, entry]) => {
      const record = { id };
      for (const field of fields) if (entry[field] !== undefined) record[field] = entry[field];
      return record;
    });
}

// ---------------------------------------------------------------------------
// The whole document.
// ---------------------------------------------------------------------------

/**
 * Which merge rule each section gets. `fields` names the payload a tracked
 * entry carries beyond its id.
 */
export const TRACKED_SECTIONS = {
  pinned: { fields: [] },           // Planner: starred assignments
  dismissed: { fields: [] },        // Planner: hidden assignments
  pinnedCourses: { fields: [] },    // Study: pinned courses
  pinnedNotes: { fields: ["title"] },
  studyList: { fields: ["text", "savedAt"] },
};

/**
 * Merge a whole prefs document.
 *
 * `local` is this device's view and `remote` is the stored one. Order is
 * irrelevant for every section except the two last-write-wins ones at the
 * bottom, which keep the existing behaviour deliberately: hidden courses and
 * display prefs are set deliberately on one device, and a per-field merge of
 * them would be machinery for a conflict nobody has.
 */
export function mergeSyncedPrefs(local, remote, { now = Date.now() } = {}) {
  const a = local && typeof local === "object" ? local : {};
  const b = remote && typeof remote === "object" ? remote : {};
  const out = {};

  out.studyActivity = mergeDateSet(a.studyActivity, b.studyActivity);
  out.noteProgress = mergeNoteProgress(a.noteProgress, b.noteProgress);
  for (const [section, { fields }] of Object.entries(TRACKED_SECTIONS)) {
    out[section] = mergeTracked(a[section], b[section], { now, fields });
  }

  // Settings: whole-value last write wins, unchanged from before this module
  // existed. `local` is the more recent view by construction — it is the device
  // asking. These are set deliberately, on one device, rarely; a per-field
  // merge of them would be machinery for a conflict nobody has, and it would
  // make "turn the tutor off" ambiguous rather than obvious.
  //
  // kbSettings is the tutor's own configuration (tutorEnabled, tutorEffort) as
  // well as scope, sort, density and speech rate. Note what is NOT here and
  // cannot be: there is no custom-model setting to sync. api/ai-router.js picks
  // a provider per request and rotates across nine of them, and AGENTS.md makes
  // not pinning the tutor to one model a hard rule. `tutorEffort` is the knob
  // that exists, and it is the one that belongs on both devices.
  for (const [key, isValid] of [
    ["hiddenCourseIds", Array.isArray],
    ["display", (v) => v && typeof v === "object"],
    ["kbSettings", (v) => v && typeof v === "object"],
  ]) {
    const value = isValid(a[key]) ? a[key] : isValid(b[key]) ? b[key] : null;
    if (!value) continue;
    out[key] = key === "hiddenCourseIds" ? value.map((id) => str(id, 240)).filter(Boolean) : value;
  }

  return out;
}
