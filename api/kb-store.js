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

import { jsonResponse } from "./_helpers.js";

// Vercel's Upstash KV integration injects UPSTASH_REDIS_REST_URL / _TOKEN by
// default, but some setups (or manual KV bindings) use KV_REST_API_URL / _TOKEN.
// Support both so the shared DB persists regardless of how the store is bound.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const BUNDLE_KEY = "kb:bundle";
const META_KEY = "kb:meta";
// Sharding: split notes into <=SHARD_NOTES chunks (kb:shard:0..N) + a tiny
// kb:shards index ({count}). Defeats the KV per-value size limit that a single
// notes array would hit past ~2.5k notes. Reads reassemble the shards.
const SHARD_NOTES = 400;
// Hard ceiling on a single KV value size (Upstash free tier: 1 MB per value).
// Shards are split until the LARGEST shard falls under this limit, so we never
// hit the per-value size error even after the body cap was removed in
// bundleFromVault (bodies can now run to 10s of KB each).
const SHARD_BYTE_LIMIT = 900 * 1024;
const SHARDS_KEY = "kb:shards";
const shardKey = (i) => `kb:shard:${i}`;

// Per-note JSON overhead (title/summary/course/year/topic/path wrappers).
const NOTE_OVERHEAD = 250;

// Split notes into shards that each stay under SHARD_BYTE_LIMIT bytes.
// Greedy: walk notes in given order, open a new shard whenever adding the next
// note would exceed the limit (always placing at least one note per shard so a
// single oversized note can never infinite-loop).
function planShards(notes) {
  const shards = [];
  let cur = [];
  let curBytes = 0;
  for (const n of notes) {
    const nb = NOTE_OVERHEAD + (n && n.x ? n.x.length : 0);
    if (cur.length > 0 && curBytes + nb > SHARD_BYTE_LIMIT) {
      shards.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(n);
    curBytes += nb;
  }
  if (cur.length > 0) shards.push(cur);
  return shards.length ? shards : [[]];
}

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

// ---- sharded read/write helpers ----
async function writeSharded(notes, source) {
  const shards = planShards(notes);
  const shardCount = shards.length;
  if (!kvAvailable()) {
    shards.forEach((shard, i) => mem.set(shardKey(i), shard));
    mem.set(SHARDS_KEY, { count: shardCount });
    mem.set("kb:src", source || "vault");
    return;
  }
  for (let i = 0; i < shardCount; i++) {
    await kvSetJSON(shardKey(i), shards[i]);
  }
  const prev = await kvGetJSON(SHARDS_KEY);
  const prevCount = prev?.count || 0;
  for (let i = shardCount; i < prevCount; i++) {
    await fetch(`${KV_URL}/del/${encodeURIComponent(shardKey(i))}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
  }
  await kvSetJSON(SHARDS_KEY, { count: shardCount });
}

async function readShardedNotes() {
  if (!kvAvailable()) {
    const all = [];
    const shards = mem.get(SHARDS_KEY)?.count || 0;
    for (let i = 0; i < shards; i++) all.push(...(mem.get(shardKey(i)) || []));
    return all;
  }
  const shards = (await kvGetJSON(SHARDS_KEY))?.count || 0;
  const out = [];
  for (let i = 0; i < shards; i++) {
    const slice = await kvGetJSON(shardKey(i));
    if (Array.isArray(slice)) out.push(...slice);
  }
  return out;
}

function bundleFromNotes(notes, extra = {}) {
  const years = [...new Set(notes.map((n) => n.y).filter(Boolean))].sort();
  const courseNames = [...new Set(notes.map((n) => n.course).filter(Boolean))].sort();
  const courses = courseNames.map((name) => ({
    name,
    y: null,
    family: null,
    noteCount: notes.filter((n) => n.course === name).length,
  }));
  return {
    version: 1,
    source: extra.source || "vault",
    generatedAt: new Date().toISOString(),
    years,
    courses,
    notes,
    clusters: extra.clusters || [],
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
  };
}

/** Load the shared knowledge-base bundle, or null if none has been built yet. */
export async function getBundle() {
  const notes = await readShardedNotes();
  const shardsPresent = kvAvailable() ? !!(await kvGetJSON(SHARDS_KEY)) : !!mem.get(SHARDS_KEY);
  if (notes.length === 0 && !shardsPresent) return null;
  const source = !kvAvailable() ? mem.get("kb:src") || "vault" : "vault";
  return bundleFromNotes(notes, { source });
}

/** Persist the shared knowledge-base bundle (the safekeep). */
export async function saveBundle(bundle) {
  const notes = Array.isArray(bundle.notes) ? bundle.notes : [];
  const meta = {
    noteCount: notes.length,
    years: Array.isArray(bundle.years) ? bundle.years : [],
    courses: Array.isArray(bundle.courses) ? bundle.courses.length : 0,
    courseList: Array.isArray(bundle.courses) ? bundle.courses : [],
    generatedAt: bundle.generatedAt || null,
    updatedAt: new Date().toISOString(),
    shards: planShards(notes).length,
  };
  await writeSharded(notes, bundle.source);
  if (kvAvailable()) await kvSetJSON(META_KEY, meta);
  else mem.set(META_KEY, meta);
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

/**
 * Append notes from `incoming` into the existing shared bundle (or create it).
 * Notes are deduped by their path `p`; an incoming note with a path that already
 * exists REPLACES the stored one (so re-seeding a chunk updates in place rather
 * than duplicating). Years/courses facets are recomputed from the merged set.
 * Used by chunked vault ingestion (each POST adds a slice instead of overwriting).
 */
export async function appendBundle(incoming) {
  const prev = (await getBundle()) || { version: 1, notes: [], years: [], courses: [], source: "vault" };
  const byPath = new Map((prev.notes || []).map((n) => [n.p, n]));
  for (const n of incoming.notes || []) {
    if (n && n.p != null) byPath.set(n.p, n);
    else byPath.set(`_${byPath.size}`, n); // safety for pathless notes
  }
  const notes = [...byPath.values()];
  const years = [...new Set(notes.map((n) => n.y).filter(Boolean))].sort();
  const courseNames = [...new Set(notes.map((n) => n.course).filter(Boolean))].sort();
  const courses = courseNames.map((name) => ({
    name,
    y: null,
    family: null,
    noteCount: notes.filter((n) => n.course === name).length,
  }));
  const merged = {
    version: 1,
    source: "vault",
    generatedAt: new Date().toISOString(),
    years,
    courses,
    notes,
    clusters: prev.clusters || [],
    ...(incoming.metadata ? { metadata: incoming.metadata } : {}),
  };
  await saveBundle(merged);
  return merged;
}

/** True when a shared knowledge base exists. */
export async function hasBundle() {
  return (await getBundle()) != null;
}

// ---------------------------------------------------------------------------
// HTTP route: GET /api/kb-store?action=export
// Returns the full shared knowledge-base bundle (reassembled from shards) as JSON.
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
