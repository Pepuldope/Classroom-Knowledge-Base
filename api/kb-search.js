import { jsonResponse } from "./_helpers.js";
import { getBundle, getMeta } from "./kb-store.js";
import { searchNotes, suggestCorrection, makeSortFn } from "./kb-retrieval.js";
import { deriveFamily } from "./kb-family.js";
import { searchResponseCacheState, SEARCH_RESPONSE_CACHE_TTL_MS } from "./kb-response-cache.js";

export const config = { runtime: "edge" };

/**
 * Legacy GET compatibility route; active search runs over the user's local bundle.
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
function timedJsonResponse(start, body, status = 200, metric = "kb-search") {
  const timing = `${metric};dur=${Date.now() - start}`;
  return jsonResponse(body, status, { "Server-Timing": timing, "X-Server-Timing": timing });
}

let searchResponseCache = null;

export default async function handler(req) {
  const start = Date.now();
  if (req.method !== "GET") return timedJsonResponse(start, { error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 8));
  const courseFilter = (url.searchParams.get("course") || "").trim();
  const yearFilter = (url.searchParams.get("year") || "").trim();
  const kindFilter = (url.searchParams.get("kind") || "").trim();
  const familyFilter = (url.searchParams.get("family") || "").trim();
  const sort = (url.searchParams.get("sort") || "relevance").trim();
  if (!q) return timedJsonResponse(start, { error: "q required" }, 400);

  const bundle = await getBundle();
  if (!bundle || !Array.isArray(bundle.notes) || bundle.notes.length === 0) {
    return timedJsonResponse(
      start,
      { meta: await getMeta(), results: [], filters: { courses: [], years: [], kinds: [], families: [] }, empty: true }
    );
  }

  const cacheKey = JSON.stringify({ q, limit, courseFilter, yearFilter, kindFilter, familyFilter, sort });
  const cachedResponse = searchResponseCacheState(
    searchResponseCache,
    cacheKey,
    bundle,
    Date.now(),
    SEARCH_RESPONSE_CACHE_TTL_MS,
  );
  if (cachedResponse) return timedJsonResponse(start, cachedResponse, 200, "kb-search;desc=cache");

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
  searchResponseCache = { key: cacheKey, bundle, response, cachedAt: Date.now() };
  return timedJsonResponse(start, response, 200);
}
