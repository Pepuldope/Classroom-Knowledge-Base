import { noteProgressKey } from "./study-progress.js";

function cleanNotes(notes) {
  return (Array.isArray(notes) ? notes : []).map((note, index) => ({
    index,
    key: noteProgressKey(note),
    note: note && typeof note === "object" ? note : {},
  })).filter(({ note }) => String(note.t || "").trim());
}

function yearKey(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "undated") return "";
  return text;
}

// Looked up by the note's stable key, not its array position — see
// study-progress.js for why the index was wrong.
function openedAt(progress, key) {
  const value = progress && typeof progress === "object" && key ? progress[key] : null;
  return String(value?.lastOpened || "");
}

function sortByStudyPriority(a, b) {
  return yearKey(b.note.y).localeCompare(yearKey(a.note.y)) ||
    String(a.note.course || "").localeCompare(String(b.note.course || "")) ||
    String(a.note.t || "").localeCompare(String(b.note.t || ""));
}

function sortByRecentActivity(a, b) {
  return openedAt(b.progress, b.key).localeCompare(openedAt(a.progress, a.key)) || sortByStudyPriority(a, b);
}

export function buildReviewDigest(notes, progress = {}, limit = 3) {
  const size = Number.isFinite(Number(limit)) ? Math.min(8, Math.max(1, Math.round(Number(limit)))) : 3;
  const cleanProgress = progress && typeof progress === "object" ? progress : {};
  const candidates = cleanNotes(notes).map((item) => ({ ...item, progress: cleanProgress }));
  const unopened = candidates.filter(({ key }) => !openedAt(cleanProgress, key)).sort(sortByStudyPriority);
  const pool = unopened.length ? unopened : candidates.sort(sortByRecentActivity);
  const items = pool.slice(0, size).map(({ note, index }) => ({
    index,
    title: String(note.t).trim(),
    detail: [note.course, note.topic || note.y].filter(Boolean).join(" · "),
  }));
  return {
    title: "Your weekly review",
    detail: unopened.length ? "A few notes you have not explored yet." : "You have already explored this bundle — revisit a few recent notes.",
    items,
  };
}
