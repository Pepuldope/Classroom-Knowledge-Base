import { jsonResponse } from "./_helpers.js";
import { getBundle, getMeta } from "./kb-store.js";
import { searchNotes, suggestCorrection } from "./kb-retrieval.js";

export const config = { runtime: "edge" };

/**
 * GET /api/kb-search?q=...&limit=8&course=Math&year=2025-26
 * Public (no auth) search over the shared knowledge base.
 * Returns { meta, results: [{ t, course, y, topic, p, _score, _snippet }],
 *          filters: { courses:[...], years:[...] } }
 */
export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 8));
  const courseFilter = (url.searchParams.get("course") || "").trim();
  const yearFilter = (url.searchParams.get("year") || "").trim();
  if (!q) return jsonResponse({ error: "q required" }, 400);

  const bundle = await getBundle();
  if (!bundle || !Array.isArray(bundle.notes) || bundle.notes.length === 0) {
    return jsonResponse({ meta: await getMeta(), results: [], filters: { courses: [], years: [] }, empty: true }, 200);
  }

  // Derive the distinct course/year facets so the UI can render filter chips.
  const courseSet = new Set();
  const yearSet = new Set();
  for (const n of bundle.notes) {
    if (n.course) courseSet.add(n.course);
    if (n.y) yearSet.add(n.y);
  }
  const facets = {
    courses: Array.from(courseSet).sort((a, b) => a.localeCompare(b)),
    years: Array.from(yearSet).sort(),
  };

  let notes = bundle.notes;
  if (courseFilter || yearFilter) {
    notes = notes.filter(
      (n) =>
        (!courseFilter || (n.course || "") === courseFilter) &&
        (!yearFilter || (n.y || "") === yearFilter)
    );
  }
  const results = searchNotes(notes, q, { limit });
  const response = { meta: await getMeta(), results, filters: facets };
  // "Did you mean" — when a search returns nothing but a confident spelling
  // correction exists in the corpus, surface it so the student can one-click
  // retry. Only attached when results are empty (never nags a good query).
  if (results.length === 0 && (courseFilter === "" && yearFilter === "")) {
    const suggestion = suggestCorrection(notes, q);
    if (suggestion) response.didYouMean = suggestion;
  }
  return jsonResponse(response, 200);
}
