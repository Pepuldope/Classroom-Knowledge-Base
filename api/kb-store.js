// kb-store.js — shared "safekeep" database for the Knowledge Base.
//
// The original Classroom-Web-Analyzer keeps each student's archive in their
// own browser (IndexedDB). This project instead persists ONE shared classroom
// knowledge base on the server, so every student can search it and the AI
// tutor can reference it.
//
// Storage backend: Upstash KV, accessed through Vercel's standard env vars
// KV_REST_API_URL / KV_REST_API_TOKEN. The calls use only the Web-standard
// `fetch` API, so this module is fully Edge-runtime compatible (no node:fs /
// node:path, which are NOT available in Vercel Edge functions).
//
// When those env vars are absent (e.g. local `vercel dev` without a KV store,
// or unit tests) we fall back to a process-memory Map. This is not durable
// across serverless invocations, so production MUST set the KV env vars.
//
// NOTE: there is deliberately NO filesystem fallback. The original used a
// .kb.local.json file, but node:fs is unsupported in the Edge runtime and
// Vercel's build fails on it ("referencing unsupported modules: node:fs").

// Vercel's Upstash KV integration injects UPSTASH_REDIS_REST_URL / _TOKEN by
// default, but some setups (or manual KV bindings) use KV_REST_API_URL / _TOKEN.
// Support both so the shared DB persists regardless of how the store is bound.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const BUNDLE_KEY = "kb:bundle";
const META_KEY = "kb:meta";

// Process-memory fallback used only when KV is not configured.
const mem = new Map();

function kvAvailable() {
  return !!KV_URL && !!KV_TOKEN;
}

async function kvGetJSON(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  if (!data || data.result == null) return null;
  try {
    return typeof data.result === "string" ? JSON.parse(data.result) : data.result;
  } catch {
    return null;
  }
}

async function kvSetJSON(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`KV set failed: ${r.status}`);
}

/** Load the shared knowledge-base bundle, or null if none has been built yet. */
export async function getBundle() {
  if (kvAvailable()) return kvGetJSON(BUNDLE_KEY);
  return mem.get(BUNDLE_KEY) || null;
}

/** Persist the shared knowledge-base bundle (the safekeep). */
export async function saveBundle(bundle) {
  const meta = {
    noteCount: Array.isArray(bundle.notes) ? bundle.notes.length : 0,
    years: Array.isArray(bundle.years) ? bundle.years : [],
    courses: Array.isArray(bundle.courses) ? bundle.courses.length : 0,
    courseList: Array.isArray(bundle.courses) ? bundle.courses : [],
    generatedAt: bundle.generatedAt || null,
    updatedAt: new Date().toISOString(),
  };
  if (kvAvailable()) {
    await kvSetJSON(BUNDLE_KEY, bundle);
    await kvSetJSON(META_KEY, meta);
    return;
  }
  mem.set(BUNDLE_KEY, bundle);
  mem.set(META_KEY, meta);
}

/** Read-only metadata about the current safekeep (counts, dates). */
export async function getMeta() {
  if (kvAvailable()) {
    const m = await kvGetJSON(META_KEY);
    if (m) return m;
  }
  const b = await getBundle();
  if (!b) return null;
  return {
    noteCount: Array.isArray(b.notes) ? b.notes.length : 0,
    years: Array.isArray(b.years) ? b.years : [],
    courses: Array.isArray(b.courses) ? b.courses.length : 0,
    courseList: Array.isArray(b.courses) ? b.courses : [],
    generatedAt: b.generatedAt || null,
    updatedAt: b.generatedAt || null,
  };
}

/** True when a shared knowledge base exists. */
export async function hasBundle() {
  return (await getBundle()) != null;
}

// ---------------------------------------------------------------------------
// HTTP route: GET /api/kb-store?action=export
// Returns the full shared knowledge-base bundle (kb:bundle) as JSON.
// Public (no auth): the shared DB is readable by anyone.
// ---------------------------------------------------------------------------
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
