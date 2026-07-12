import { jsonResponse, verifyUser } from "./_helpers.js";
import { saveBundle, getBundle, getMeta, appendBundle } from "./kb-store.js";
import { bundleFromRaw, bundleFromVault } from "../archive-builder.js";

export const config = { runtime: "edge" };

// Write-guard: the shared KB is overwritten wholesale by this endpoint, so it
// MUST be authenticated. Two ways to prove write authority:
//   1. A verified Google user (their OAuth token) — required for the
//      user-facing `classroom` scrape path.
//   2. A shared server secret (KB_WRITE_TOKEN) sent as `X-KB-Write-Token` —
//      used by the autonomous loop + offline seed-vault.mjs, which have no
//      Google login.
// Either is sufficient. Without one, the write is rejected (HTTP 401).
async function requireWriteAuth(req) {
  // Path 2: shared server secret (loop / seed script).
  const secret = process.env.KB_WRITE_TOKEN;
  if (secret) {
    const provided = req.headers.get("x-kb-write-token") || "";
    if (provided && provided === secret) return { ok: true, via: "secret" };
  }
  // Path 1: verified Google user.
  const sub = await verifyUser(req);
  if (sub) return { ok: true, via: "google", sub };
  return { ok: false };
}

/**
 * Persist a full Classroom scrape into the SHARED knowledge base (the safekeep).
 *
 * Two ways to populate it:
 *   1. POST { source: "classroom", authToken: "<google access token>" }
 *      -> we use the caller's own Classroom access token to fetch everything
 *         (courses, coursework, materials, announcements, submissions) and
 *         synthesize the bundle server-side, then save it to the shared DB.
 *         Requires the same Classroom read-only scopes to be granted to the app.
 *   2. POST { source: "bundle", bundle: { ...archive.json... } }
 *      -> caller supplies an already-built bundle (e.g. the offline School
 *         Backup pipeline's archive.json, or a bundle built client-side by
 *         archive-builder.js). We validate and save it.
 *   3. POST { source: "vault", notes: [...] }
 *      -> offline seed script walked a vault and ships raw notes; we synthesize
 *         the normalized KB bundle server-side (pure + testable). Uses
 *         appendBundle so chunked seeding accumulates instead of overwriting.
 *
 * AUTH: every write requires EITHER a verified Google user (Bearer token) OR a
 * shared server secret sent as `X-KB-Write-Token` (env KB_WRITE_TOKEN). The
 * classic read paths (/api/kb-search, /api/kb-store export) remain public.
 */
export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  // CRITICAL: this endpoint overwrites the shared KB — require write auth.
  const auth = await requireWriteAuth(req);
  if (!auth.ok) return jsonResponse({ error: "Unauthorized — write token or verified Google user required" }, 401);

  const body = await req.json().catch(() => null);
  if (!body) return jsonResponse({ error: "bad json" }, 400);

  // ---- Path 2: a ready-made bundle is supplied ----
  if (body.source === "bundle" && body.bundle) {
    const b = body.bundle;
    if (typeof b !== "object" || b.version !== 1 || !Array.isArray(b.notes)) {
      return jsonResponse({ error: "bundle must be {version:1, notes:[...]}" }, 400);
    }
    await saveBundle(b);
    const meta = await getMeta();
    return jsonResponse({ ok: true, meta });
  }

  // ---- Path 3: a vault of raw notes (already walked offline) ----
  // Vercel's Edge runtime forbids node:fs, so the filesystem walk happens in
  // scripts/seed-vault.mjs (on a machine with the vault). It POSTs the raw
  // notes; we synthesize the normalized KB bundle here (pure + testable).
  // Uses appendBundle so chunked seeding accumulates instead of overwriting.
  if (body.source === "vault") {
    const rawNotes = Array.isArray(body.notes) ? body.notes : [];
    if (rawNotes.length === 0) return jsonResponse({ error: "vault needs notes:[]" }, 400);
    const bundle = bundleFromVault(rawNotes, body.meta || {});
    await appendBundle(bundle);
    const meta = await getMeta();
    return jsonResponse({ ok: true, meta });
  }

  // ---- Path 1: fetch live from Classroom using the caller's token ----
  if (body.source === "classroom") {
    const authToken = body.authToken || "";
    if (!authToken) return jsonResponse({ error: "authToken (Google access token) required" }, 400);

    const gFetch = async (url) => {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
      if (!r.ok) throw new Error(`Classroom API ${r.status}: ${await r.text().catch(() => "")}`);
      return r.json();
    };

    try {
      const bundle = await bundleFromRawWithFetch(gFetch);
      await saveBundle(bundle);
      const meta = await getMeta();
      return jsonResponse({ ok: true, meta });
    } catch (e) {
      return jsonResponse({ error: "scrape_failed", details: String(e.message || e) }, 502);
    }
  }

  return jsonResponse({ error: "unknown source — send {source:'classroom'} or {source:'bundle', bundle}" }, 400);
}

// Same facet fetch logic as archive-builder.js's buildArchiveFromClassroom, but
// takes a gFetch instead of needing app.js. Returns the synthesized bundle.
async function bundleFromRawWithFetch(gFetch) {
  const CLASSROOM_BASE = "https://classroom.googleapis.com/v1";
  const PAGE_SIZE = 100;
  const fetchAll = async (urlBuilder, listKey) => {
    const items = [];
    let pageToken;
    do {
      const resp = await gFetch(urlBuilder(pageToken));
      const page = resp[listKey];
      if (Array.isArray(page)) items.push(...page);
      pageToken = resp.nextPageToken || null;
    } while (pageToken);
    return items;
  };
  const courses = await fetchAll(
    (pt) => `${CLASSROOM_BASE}/courses?courseStates=ACTIVE&courseStates=ARCHIVED&pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`,
    "courses"
  );
  const courseData = {};
  for (const course of courses) {
    const [topics, courseWork, courseWorkMaterials, announcements, submissions] = await Promise.all([
      fetchAll((pt) => `${CLASSROOM_BASE}/courses/${course.id}/topics?pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`, "topic").catch(() => []),
      fetchAll((pt) => `${CLASSROOM_BASE}/courses/${course.id}/courseWork?pageSize=${PAGE_SIZE}&courseWorkStates=PUBLISHED${pt ? `&pageToken=${pt}` : ""}`, "courseWork").catch(() => []),
      fetchAll((pt) => `${CLASSROOM_BASE}/courses/${course.id}/courseWorkMaterials?pageSize=${PAGE_SIZE}&courseWorkMaterialStates=PUBLISHED${pt ? `&pageToken=${pt}` : ""}`, "courseWorkMaterial").catch(() => []),
      fetchAll((pt) => `${CLASSROOM_BASE}/courses/${course.id}/announcements?pageSize=${PAGE_SIZE}&announcementStates=PUBLISHED${pt ? `&pageToken=${pt}` : ""}`, "announcements").catch(() => []),
      fetchAll((pt) => `${CLASSROOM_BASE}/courses/${course.id}/courseWork/-/studentSubmissions?userId=me&pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`, "studentSubmissions").catch(() => []),
    ]);
    courseData[course.id] = { topics, courseWork, courseWorkMaterials, announcements, submissions };
  }
  return bundleFromRaw({ courses, courseData });
}
