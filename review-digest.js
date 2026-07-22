function cleanNotes(notes) {
  return (Array.isArray(notes) ? notes : []).map((note, index) => ({
    index,
    note: note && typeof note === "object" ? note : {},
  })).filter(({ note }) => String(note.t || "").trim());
}

function yearKey(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "undated") return "";
  return text;
}

function openedAt(progress, index) {
  const value = progress && typeof progress === "object" ? progress[index] : null;
  return String(value?.lastOpened || "");
}

function sortByStudyPriority(a, b) {
  return yearKey(b.note.y).localeCompare(yearKey(a.note.y)) ||
    String(a.note.course || "").localeCompare(String(b.note.course || "")) ||
    String(a.note.t || "").localeCompare(String(b.note.t || ""));
}

function sortByRecentActivity(a, b) {
  return openedAt(b.progress, b.index).localeCompare(openedAt(a.progress, a.index)) || sortByStudyPriority(a, b);
}

export function buildReviewDigest(notes, progress = {}, limit = 3) {
  const size = Number.isFinite(Number(limit)) ? Math.min(8, Math.max(1, Math.round(Number(limit)))) : 3;
  const cleanProgress = progress && typeof progress === "object" ? progress : {};
  const candidates = cleanNotes(notes).map((item) => ({ ...item, progress: cleanProgress }));
  const unopened = candidates.filter(({ index }) => !openedAt(cleanProgress, index)).sort(sortByStudyPriority);
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
