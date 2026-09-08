// study-progress.js — how much of the corpus has been opened, and when.
//
// Keyed by the note's PATH, not its position in the notes array.
//
// It used to be the array index, which made every entry a pointer into a list
// that moves. mergeBundles re-files a note by deleting its old path and adding
// the new one at the end, so correcting one course's year shifted every note
// after it: "opened 3 times, last on 2026-09-07" silently transferred from one
// note to a different one. Paths are already the merge's identity for a note,
// and the pinned-notes feature next door has always used a stable content id
// rather than an index.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_KEY = 400;

/** The stable key for a note. Falls back to its content when it has no path. */
export function noteProgressKey(note) {
  if (typeof note === "string") return note.trim().slice(0, MAX_KEY);
  const path = String(note?.p || "").trim();
  if (path) return path.slice(0, MAX_KEY);
  const title = String(note?.t || "").trim();
  if (!title) return "";
  return [note?.course, note?.y, title, note?.topic]
    .map((value) => String(value || "").trim())
    .join("|")
    .slice(0, MAX_KEY);
}

function cleanProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [id, item] of Object.entries(value)) {
    if (!id || id.length > MAX_KEY || !item || typeof item !== "object") continue;
    const opened = Math.max(0, Math.floor(Number(item.opened) || 0));
    const lastOpened = DATE_RE.test(item.lastOpened || "") ? item.lastOpened : null;
    if (opened || lastOpened) result[id] = { opened, ...(lastOpened ? { lastOpened } : {}) };
  }
  return result;
}

/**
 * Convert an index-keyed record to path keys, and drop entries for notes that
 * are no longer in the corpus.
 *
 * Both halves matter. Without the first, everyone's existing progress reads as
 * a pointer into the wrong list; without the second, deleting a course leaves
 * its progress behind forever, inflating "N of M notes opened" above what the
 * corpus even contains.
 *
 * Returns the same object shape, so it is safe to run on every load — a record
 * that is already migrated and already clean comes back unchanged.
 */
export function migrateNoteProgress(value, notes) {
  const list = Array.isArray(notes) ? notes : [];
  const known = new Set();
  const byIndex = new Map();
  list.forEach((note, index) => {
    const key = noteProgressKey(note);
    if (!key) return;
    known.add(key);
    byIndex.set(String(index), key);
  });

  const cleaned = cleanProgress(value);
  const next = {};
  for (const [id, item] of Object.entries(cleaned)) {
    // A key that is a bare integer AND not itself a known note path is a
    // legacy index. Real paths start with a year segment, so they never
    // collide with this.
    const key = /^\d+$/.test(id) && !known.has(id) ? byIndex.get(id) : id;
    if (!key || !known.has(key)) continue; // the note is gone
    const current = next[key];
    if (!current) { next[key] = item; continue; }
    // Two legacy indices can land on one note only if the corpus shrank; keep
    // the fuller record rather than whichever came last.
    next[key] = {
      opened: Math.max(current.opened, item.opened),
      ...((current.lastOpened || item.lastOpened)
        ? { lastOpened: [current.lastOpened, item.lastOpened].filter(Boolean).sort().at(-1) }
        : {}),
    };
  }
  return next;
}

export function recordNoteProgress(value, noteId, date) {
  const id = noteProgressKey(noteId);
  if (!id || !DATE_RE.test(String(date || ""))) return cleanProgress(value);
  const next = cleanProgress(value);
  const current = next[id] || { opened: 0 };
  next[id] = { opened: current.opened + (current.lastOpened === date ? 0 : 1), lastOpened: date };
  return next;
}

export function studyProgressModel(value, totalNotes) {
  const entries = Object.entries(cleanProgress(value));
  const total = Math.max(0, Math.floor(Number(totalNotes) || 0));
  const lastOpened = entries.map(([, item]) => item.lastOpened).filter(Boolean).sort().at(-1) || null;
  const openedNotes = Math.min(total, entries.length);
  return {
    openedNotes,
    totalNotes: total,
    percent: total ? Math.round((openedNotes / total) * 100) : 0,
    lastOpened,
  };
}

export function studyProgressCopy(summary) {
  if (!summary || typeof summary !== "object" ||
      !Number.isFinite(summary.totalNotes) || summary.totalNotes <= 0 ||
      !Number.isFinite(summary.openedNotes) || !Number.isFinite(summary.percent)) {
    return {
      headline: "📖 Start exploring",
      detail: "Open a note from your local knowledge base to track progress here.",
    };
  }
  return {
    headline: `📖 ${summary.percent}% explored`,
    detail: `${summary.openedNotes.toLocaleString()} of ${summary.totalNotes.toLocaleString()} notes opened${summary.lastOpened ? ` · last opened ${summary.lastOpened}` : ""}`,
  };
}
