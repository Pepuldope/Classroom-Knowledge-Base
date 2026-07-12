import { jsonResponse } from "./_helpers.js";
import { getBundle } from "./kb-store.js";
import { relatedNotes } from "./kb-retrieval.js";

export const config = { runtime: "edge" };

/**
 * GET /api/kb-related?id=<index>&limit=5
 * Public (no auth) cross-link lookup: returns notes related to the note at the
 * given bundle index — sharing its course, topic, or overlapping key terms.
 * Powers the "Related notes" panel on each search-result / note-detail view.
 *
 * Returns { related: [{ t, course, y, topic, p, noteIndex, _score, _snippet }] }
 * or 400 (missing id) / 404 (no bundle / out-of-range id).
 */
export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const raw = url.searchParams.get("id");
  if (raw === null || raw === "") return jsonResponse({ error: "id required" }, 400);
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) return jsonResponse({ error: "invalid id" }, 400);

  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 5));

  const bundle = await getBundle();
  if (!bundle || !Array.isArray(bundle.notes) || bundle.notes.length === 0) {
    return jsonResponse({ error: "no knowledge base" }, 404);
  }
  if (id >= bundle.notes.length) return jsonResponse({ error: "note not found" }, 404);

  const target = bundle.notes[id];
  const related = relatedNotes(bundle.notes, target, { limit });
  return jsonResponse({ related }, 200);
}
