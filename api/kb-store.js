// kb-store.js — shared "safekeep" database for the Knowledge Base.
//
// The original Classroom-Web-Analyzer keeps each student's archive in their
// own browser (IndexedDB). This project instead persists ONE shared classroom
// knowledge base on the server, so every student can search it and the AI
// tutor can reference it.
//
// Storage backend (same as the original's prefs/chat): Upstash KV via
// KV_REST_API_URL / KV_REST_API_TOKEN. When those env vars are absent
// (local `vercel dev` without KV), we fall back to a JSON file on disk so
// the whole flow can be developed and tested locally.
import { promises as fs } from "node:fs";
import path from "node:path";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BUNDLE_KEY = "kb:bundle";
const META_KEY = "kb:meta";
const LOCAL_PATH = path.join(process.cwd(), ".kb.local.json");

function kvAvailable() {
  return !!KV_URL && !!KV_TOKEN;
}

async function kvGetJSON(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  if (!data || data.result == null) return null;
  try { return typeof data.result === "string" ? JSON.parse(data.result) : data.result; }
  catch { return null; }
}

async function kvSetJSON(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`KV set failed: ${r.status}`);
}

async function fileGetJSON() {
  try {
    const txt = await fs.readFile(LOCAL_PATH, "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}
async function fileSetJSON(value) {
  await fs.writeFile(LOCAL_PATH, JSON.stringify(value), "utf8");
}

/** Load the shared knowledge-base bundle, or null if none has been built yet. */
export async function getBundle() {
  if (kvAvailable()) return kvGetJSON(BUNDLE_KEY);
  return fileGetJSON();
}

/** Persist the shared knowledge-base bundle (the safekeep). */
export async function saveBundle(bundle) {
  if (kvAvailable()) {
    await kvSetJSON(BUNDLE_KEY, bundle);
    await kvSetJSON(META_KEY, {
      noteCount: Array.isArray(bundle.notes) ? bundle.notes.length : 0,
      years: Array.isArray(bundle.years) ? bundle.years : [],
      courses: Array.isArray(bundle.courses) ? bundle.courses.length : 0,
      generatedAt: bundle.generatedAt || null,
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  await fileSetJSON(bundle);
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
    generatedAt: b.generatedAt || null,
    updatedAt: b.generatedAt || null,
  };
}

/** True when a shared knowledge base exists. */
export async function hasBundle() {
  return (await getBundle()) != null;
}
