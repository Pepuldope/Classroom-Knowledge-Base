// Pure accessibility copy for related-note previews.
// It intentionally exposes only state/count metadata, never note content.
export function relatedPreviewAnnouncement(state = "loading", { cached = false, count = 0 } = {}) {
  const safeCount = Number.isInteger(count) && count >= 0 ? count : 0;
  if (state === "error") {
    const suffix = safeCount > 1 ? ` still unavailable after ${safeCount} attempts` : " unavailable";
    return { role: "status", live: "polite", text: `Related notes${suffix}. Retry loading related notes.` };
  }
  if (state === "ready") {
    const noun = safeCount === 1 ? "note" : "notes";
    const source = cached ? " from your local cache" : "";
    return { role: "status", live: "polite", text: `${safeCount} related ${noun} loaded${source}.` };
  }
  return {
    role: "status",
    live: "polite",
    text: cached ? "Loading related notes from your local cache…" : "Loading related notes…",
  };
}
