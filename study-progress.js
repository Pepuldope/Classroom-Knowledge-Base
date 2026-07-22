const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [id, item] of Object.entries(value)) {
    if (!/^\d+$/.test(id) || !item || typeof item !== "object") continue;
    const opened = Math.max(0, Math.floor(Number(item.opened) || 0));
    const lastOpened = DATE_RE.test(item.lastOpened || "") ? item.lastOpened : null;
    if (opened || lastOpened) result[id] = { opened, ...(lastOpened ? { lastOpened } : {}) };
  }
  return result;
}

export function recordNoteProgress(value, noteId, date) {
  const id = String(noteId ?? "").trim();
  if (!/^\d+$/.test(id) || !DATE_RE.test(String(date || ""))) return cleanProgress(value);
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
