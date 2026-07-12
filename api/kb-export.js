// kb-export.js — GET /api/kb-store?action=export
// Returns the full shared knowledge-base bundle (kb:bundle) as JSON.
// Public (no auth): the shared DB is meant to be readable by anyone.
import { jsonResponse } from "./_helpers.js";
import { getBundle } from "./kb-store.js";

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  if ((url.searchParams.get("action") || "") !== "export") {
    return jsonResponse({ error: "unknown action" }, 400);
  }
  const bundle = await getBundle();
  if (!bundle) return jsonResponse({ bundle: null, empty: true }, 200);
  return jsonResponse({ bundle }, 200);
}
