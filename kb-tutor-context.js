// Pure browser-side grounding selection for the KB tutor.
// Only notes selected by local retrieval cross the tutor request boundary.

import { searchNotes } from "./kb-client-search.js";

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 8;

export function buildTutorRetrievedNotes(bundle, query, { limit = DEFAULT_LIMIT } = {}) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const numericLimit = Number(limit);
  const boundedLimit = Number.isFinite(numericLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(numericLimit)))
    : DEFAULT_LIMIT;
  if (!notes.length || !String(query || "").trim()) return [];

  return searchNotes(notes, query, { limit: boundedLimit }).map((result) => ({
    ...notes[result.noteIndex],
    noteIndex: result.noteIndex,
  }));
}
