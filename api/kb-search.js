import { jsonResponse } from "./_helpers.js";
import { getBundle, getMeta } from "./kb-store.js";
import { searchNotes, suggestCorrection, makeSortFn } from "./kb-retrieval.js";
import { deriveFamily } from "./kb-family.js";

export const config = { runtime: "edge" };

/**
 * GET /api/kb-search?q=...&limit=8&course=Math&year=2025-26&kind=note&family=Engineering&sort=recency
 * Public (no auth) search over the shared knowledge base.
 * Returns { meta, results: [{ t, course, y, topic, p, _score, _snippet }],
 *          filters: { courses:[...], years:[...], kinds:[...], families:[...] } }
 */
// Attach a derived family to a note (idempotent: never overwrites a real one).
function withFamily(n) {
  if (!n) return n;
  if (n.family) return n;
  const f = deriveFamily(n.course);
  return f ? { ...n, family: f } : n;
}
export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 8));
  const courseFilter = (url.searchParams.get("course") || "").trim();
  const yearFilter = (url.searchParams.get("year") || "").trim();
  const kindFilter = (url.searchParams.get("kind") || "").trim();
  const familyFilter = (url.searchParams.get("family") || "").trim();
  const sort = (url.searchParams.get("sort") || "relevance").trim();
  if (!q) return jsonResponse({ error: "q required" }, 400);

  const bundle = await getBundle();
  if (!bundle || !Array.isArray(bundle.notes) || bundle.notes.length === 0) {
    return jsonResponse({ meta: await getMeta(), results: [], filters: { courses: [], years: [], kinds: [], families: [] }, empty: true }, 200);
  }

  // Derive the distinct course/year/kind/family facets so the UI can render
  // filter chips (focus area 7: type + class-type facets join course + year).
  const courseSet = new Set();
  const yearSet = new Set();
  const kindSet = new Set();
  const familySet = new Set();
  for (const raw of bundle.notes) {
    const n = withFamily(raw);
    if (n.course) courseSet.add(n.course);
    if (n.y) yearSet.add(n.y);
    if (n.kind) kindSet.add(n.kind);
    if (n.family) familySet.add(n.family);
  }
  const facets = {
    courses: Array.from(courseSet).sort((a, b) => a.localeCompare(b)),
    years: Array.from(yearSet).sort(),
    kinds: Array.from(kindSet).sort(),
    families: Array.from(familySet).sort(),
  };

  let notes = bundle.notes.map(withFamily);
  let indexMap = notes.map((_, index) => index);
  if (courseFilter || yearFilter || kindFilter || familyFilter) {
    const filtered = notes
      .map((note, index) => ({ note, index: indexMap[index] }))
      .filter(
        ({ note: n }) =>
          (!courseFilter || (n.course || "") === courseFilter) &&
          (!yearFilter || (n.y || "") === yearFilter) &&
          (!kindFilter || (n.kind || "") === kindFilter) &&
          (!familyFilter || (n.family || "") === familyFilter)
      );
    notes = filtered.map(({ note }) => note);
    indexMap = filtered.map(({ index }) => index);
  }
  const sortFn = makeSortFn(sort);
  const results = searchNotes(notes, q, { limit, sortFn, indexMap });
  // filteredCount = how many notes the current result set was drawn from
  // (post-facet-filter, pre-limit). The UI shows "Showing N of M notes" where
  // M is filteredCount — so a course/year/kind/family filter visibly narrows M too.
  const response = { meta: await getMeta(), results, filteredCount: notes.length, filters: facets };
  // "Did you mean" — when a search returns nothing but a confident spelling
  // correction exists in the corpus, surface it so the student can one-click
  // retry. Only attached when results are empty (never nags a good query).
  if (results.length === 0 && (courseFilter === "" && yearFilter === "")) {
    const suggestion = suggestCorrection(notes, q);
    if (suggestion) response.didYouMean = suggestion;
  }
  return jsonResponse(response, 200);
}
