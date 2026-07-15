import { jsonResponse } from "./_helpers.js";

export const config = { runtime: "edge" };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return;
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

// Drops the server-side refresh token for a Google account (keyed by `sub`).
// This is what actually lets a user SWITCH accounts: without it, oauth-refresh.js
// silently re-grants a token for the previously-used account on every page load,
// so clearing the client token alone never escapes a wrong (non-Classroom) account.
export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const body = await req.json().catch(() => null);
  const sub = body?.sub;
  if (!sub) return jsonResponse({ error: "sub required" }, 400);
  await kvDel(`refresh:${sub}`);
  return jsonResponse({ ok: true });
}
