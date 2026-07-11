import { jsonResponse } from "./_helpers.js";
import { getBundle, getMeta } from "./kb-store.js";
import { searchNotes } from "./kb-retrieval.js";

export const config = { runtime: "edge" };

/**
 * GET /api/kb-search?q=...&limit=8
 * Public (no auth) search over the shared knowledge base.
 * Returns { meta, results: [{ t, course, y, topic, p, _score, _snippet }] }
 */
export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 8));
  if (!q) return jsonResponse({ error: "q required" }, 400);

  const bundle = await getBundle();
  if (!bundle || !Array.isArray(bundle.notes) || bundle.notes.length === 0) {
    return jsonResponse({ meta: await getMeta(), results: [], empty: true }, 200);
  }
  const results = searchNotes(bundle.notes, q, { limit });
  return jsonResponse({ meta: await getMeta(), results }, 200);
}
