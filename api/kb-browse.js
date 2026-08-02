import { jsonResponse } from "./_helpers.js";
import { getBundle, getMeta } from "./kb-store.js";
import { makeSortFn } from "./kb-retrieval.js";

export const config = { runtime: "edge" };

// First N chars of a note's body used as a browse snippet (no query to match
// against, so we just show the start of the note's summary/body).
const SNIPPET_LEN = 200;
function browseSnippet(note) {
  const source = note.s || note.x || "";
  if (!source) return "";
  const s = source.trim();
  return s.length > SNIPPET_LEN ? s.slice(0, SNIPPET_LEN) + "…" : s;
}

// Result shape mirrors searchNotes() so the UI can reuse its card rendering.
function toResult(note, index) {
  return {
    t: note.t || "",
    course: note.course || "",
    y: note.y || "",
    topic: note.topic || null,
    kind: note.kind || "",
    family: note.family || "",
    p: note.p || "",
    noteIndex: index,
    _score: 0,
    _snippet: browseSnippet(note),
  };
}

/**
 * GET /api/kb-browse                  -> { meta, courses:[{course,count,years}] }
 * GET /api/kb-browse?course=<name>&kind=<kind>&family=<family>&sort=<sort>
 *                                      -> { meta, notes:[...] }
 *
 * Legacy compatibility route; active browse runs over the user's local bundle.
 * This is the no-query "discover by course" entry point the KB was missing — a student
 * can explore notes without already knowing a search term.
 */
export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const course = (url.searchParams.get("course") || "").trim();
  const kind = (url.searchParams.get("kind") || "").trim();
  const family = (url.searchParams.get("family") || "").trim();
  const requestedSort = (url.searchParams.get("sort") || "recency").trim();
  const sort = new Set(["relevance", "recency", "course", "title"]).has(requestedSort)
    ? requestedSort
    : "recency";

  const bundle = await getBundle();
  if (!bundle || !Array.isArray(bundle.notes)) {
    return jsonResponse({ meta: await getMeta(), courses: [], notes: [] }, 200);
  }

  const scopedNotes = bundle.notes.filter((n) =>
    (!course || (n.course || "Uncategorised") === course) &&
    (!kind || (n.kind || "") === kind) &&
    (!family || (n.family || "") === family)
  );

  if (!course) {
    // Aggregate distinct courses with note counts + the years they span.
    const map = new Map();
    for (const n of scopedNotes) {
      const c = n.course || "Uncategorised";
      let entry = map.get(c);
      if (!entry) { entry = { course: c, count: 0, years: new Set() }; map.set(c, entry); }
      entry.count += 1;
      if (n.y) entry.years.add(n.y);
    }
    const courses = Array.from(map.values())
      .map((e) => ({ course: e.course, count: e.count, years: Array.from(e.years).sort() }))
      .sort((a, b) => b.count - a.count || a.course.localeCompare(b.course));
    return jsonResponse({ meta: await getMeta(), courses }, 200);
  }

  // Notes for the selected course, newest year first.
  const notes = scopedNotes
    .map((n) => ({ n, i: bundle.notes.indexOf(n) }))
    .map(({ n, i }) => toResult(n, i))
    .sort(makeSortFn(sort));
  return jsonResponse({ meta: await getMeta(), notes }, 200);
}
