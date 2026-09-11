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

const fold = (value) => String(value || "").trim().toLowerCase();

/**
 * Prefer notes from the class the student is actually in.
 *
 * Lexical search alone answered "what do I need to know for this quiz?" with
 * five vocabulary quizzes from four different classes across three school
 * years, because "vocabulary quiz" matches all of them equally well. When
 * something is open, its course and topic are the strongest signal available
 * about which of those the student means — stronger than any keyword in the
 * question, which is usually a generic word like "quiz" or "this".
 *
 * A stable partition, not a filter: other-course notes keep their relevance
 * order and stay available, they just stop outranking the student's own class.
 * Filtering them out would break the genuine case of a topic taught in two
 * subjects.
 */
export function rankByCourseAffinity(results, focusNote) {
  const course = fold(focusNote?.course);
  const topic = fold(focusNote?.topic);
  const year = fold(focusNote?.y);
  if (!course && !topic) return results;
  const rank = (note) => {
    // Same class AND same year is the student's current course; same class in
    // an earlier year is still theirs, and still better than a stranger's.
    let score = 0;
    if (course && fold(note?.course) === course) score += year && fold(note?.y) === year ? 4 : 3;
    if (topic && fold(note?.topic) === topic) score += 2;
    return score;
  };
  return results
    .map((result, i) => ({ result, i, rank: rank(result) }))
    .sort((a, b) => b.rank - a.rank || a.i - b.i)
    .map(({ result }) => result);
}

export function buildTutorRetrievedNotes(bundle, query, { limit = DEFAULT_LIMIT, focusNote = null } = {}) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const numericLimit = Number(limit);
  const boundedLimit = Number.isFinite(numericLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(numericLimit)))
    : DEFAULT_LIMIT;
  if (!notes.length || !String(query || "").trim()) return [];

  // Search wider than we need when there is a focus, so the re-rank has
  // same-course candidates to promote rather than only the top few keyword
  // hits — which is exactly the set that was all from the wrong classes.
  const searchLimit = focusNote ? Math.min(notes.length, boundedLimit * 4) : boundedLimit;
  const hits = searchNotes(notes, query, { limit: searchLimit }).map((result) => ({
    ...notes[result.noteIndex],
    noteIndex: result.noteIndex,
  }));
  return rankByCourseAffinity(hits, focusNote).slice(0, boundedLimit);
}
