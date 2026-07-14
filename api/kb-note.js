import { jsonResponse } from "./_helpers.js";
import { getBundle } from "./kb-store.js";

export const config = { runtime: "edge" };

/**
 * GET /api/kb-note?id=<index>
 * Full-note lookup by its stable index in the knowledge-base bundle.
 * The index comes from /api/kb-search results (noteIndex field), so a clicked
 * search result can open the entire note, not just its snippet.
 *
 * Returns { t, s, x, course, y, topic, p } — the full note — or 404 if the
 * index is out of range / no bundle exists.
 */
export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const raw = url.searchParams.get("id");
  if (raw === null || raw === "") return jsonResponse({ error: "id required" }, 400);
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) return jsonResponse({ error: "invalid id" }, 400);

  const bundle = await getBundle();
  if (!bundle || !Array.isArray(bundle.notes) || bundle.notes.length === 0) {
    return jsonResponse({ error: "no knowledge base" }, 404);
  }
  if (id >= bundle.notes.length) return jsonResponse({ error: "note not found" }, 404);

  const n = bundle.notes[id];
  return jsonResponse({
    t: n.t || "",
    s: n.s || "",
    x: n.x || "",
    course: n.course || "",
    y: n.y || "",
    topic: n.topic || null,
    p: n.p || "",
  }, 200);
}
