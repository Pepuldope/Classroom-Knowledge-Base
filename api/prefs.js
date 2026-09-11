import { mergeSyncedPrefs } from "../prefs-sync.js";

export const config = { runtime: "edge" };

// Accept both credential namings. Vercel's Upstash integration injects
// UPSTASH_REDIS_REST_URL / _TOKEN; a Vercel KV binding uses KV_REST_API_URL /
// _TOKEN. kb-store.js already accepted both, so a project provisioned through
// the Upstash integration had a working knowledge-base store while this file
// concluded there was no storage at all.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function verifyUser(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.sub || null;
}

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.result || null;
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: value,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`KV set failed: ${r.status} ${errText}`);
  }
}

function prefsKey(sub) {
  return `prefs:${sub}`;
}

/** Whatever is stored for this user, always an object. */
async function readPrefs(sub) {
  const raw = await kvGet(prefsKey(sub));
  if (!raw) return {};
  try {
    // Double-encoded values exist in the wild from an earlier writer.
    let parsed = JSON.parse(raw);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; }
}

export default async function handler(req) {
  if (!KV_URL || !KV_TOKEN) {
    return new Response(JSON.stringify({ error: "storage_not_configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sub = await verifyUser(req);
  if (!sub) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "GET") {
    try {
      return new Response(JSON.stringify({ prefs: await readPrefs(sub) }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); }
    catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400 }); }
    if (!body || typeof body.prefs !== "object" || body.prefs === null) {
      return new Response(JSON.stringify({ error: "prefs object required" }), { status: 400 });
    }
    try {
      // Merge, never replace. This endpoint used to kvSet the caller's blob
      // wholesale, so the second device to save that day erased the first
      // one's study progress, streak and pins. mergeSyncedPrefs applies a rule
      // per section: union for the streak, max/later for progress, per-id
      // last-write-wins with tombstones for the sets you can remove from.
      //
      // There is no lock around this read-modify-write, and it does not need
      // one. Every accumulating section merges commutatively and idempotently,
      // so two devices racing land on the same document whichever order they
      // arrive in, and an update lost to a race is repaired by the next sync
      // rather than lost for good. (The deliberate settings — display,
      // kbSettings, hiddenCourseIds — stay last-write-wins by design.)
      const merged = mergeSyncedPrefs(body.prefs, await readPrefs(sub));
      await kvSet(prefsKey(sub), JSON.stringify(merged));
      // Hand back what was actually stored so the caller converges on it
      // immediately instead of waiting for its next GET.
      return new Response(JSON.stringify({ ok: true, prefs: merged }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
}
