// Pure browser-side grounding selection for the KB tutor.
// Only notes selected by local retrieval cross the tutor request boundary.

import { searchNotes } from "./kb-client-search.js";

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 8;
const MAX_FIELD_LENGTHS = Object.freeze({
  t: 300,
  course: 160,
  y: 40,
  topic: 160,
  s: 1400,
  x: 1400,
});

/**
 * Strip source-only fields and cap each retrieved note before JSON serialization.
 * The server applies the same bounds defensively, but the browser should avoid
 * sending oversized bodies across the privacy boundary in the first place.
 */
export function tutorRequestNotesModel(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.slice(0, MAX_LIMIT).map((note) => {
    const bounded = {};
    for (const [field, maxLength] of Object.entries(MAX_FIELD_LENGTHS)) {
      if (typeof note?.[field] === "string") bounded[field] = note[field].slice(0, maxLength);
    }
    if (Number.isInteger(note?.noteIndex)) bounded.noteIndex = note.noteIndex;
    return bounded;
  });
}

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
