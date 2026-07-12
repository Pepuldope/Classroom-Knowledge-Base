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
  // Resumable + incremental: Vercel Edge functions hard-timeout at ~10s, so we
  // never scrape the whole Classroom in one shot. The client drives it in short
  // steps (list -> per-course), each saved via appendBundle so partial progress
  // is preserved and one slow course can't 504 the entire scrape.
  if (body.source === "classroom") {
    const authToken = body.authToken || "";
    if (!authToken) return jsonResponse({ error: "authToken (Google access token) required" }, 400);

    const gFetch = async (url) => {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
      if (!r.ok) throw new Error(`Classroom API ${r.status}: ${await r.text().catch(() => "")}`);
      return r.json();
    };

    // mode "list": return the course list so the client can iterate.
    if (body.mode === "list" || !body.mode) {
      try {
        const list = await listCourses(gFetch);
        return jsonResponse({ ok: true, mode: "list", courses: list, total: list.length });
      } catch (e) {
        return jsonResponse({ error: "list_failed", details: String(e.message || e) }, 502);
      }
    }

    // mode "course": scrape ONE course, append it, return its note count.
    if (body.mode === "course") {
      const courseId = body.courseId;
      if (!courseId) return jsonResponse({ error: "courseId required for mode:'course'" }, 400);
      try {
        const single = await scrapeOneCourse(gFetch, courseId);
        const bundle = bundleFromRaw(single);
        await appendBundle(bundle);
        const meta = await getMeta();
        return jsonResponse({
          ok: true,
          mode: "course",
          courseId,
          courseName: single.courses[0]?.name || courseId,
          notes: bundle.notes.length,
          meta,
        });
      } catch (e) {
        return jsonResponse({ error: "course_failed", courseId, details: String(e.message || e) }, 502);
      }
    }

    return jsonResponse({ error: "unknown classroom mode (use 'list' or 'course')" }, 400);
  }

  return jsonResponse({ error: "unknown source — send {source:'classroom'} or {source:'bundle', bundle}" }, 400);
}

// --- Classroom helpers (resumable, per-call bounded) ---

const CLASSROOM_BASE = "https://classroom.googleapis.com/v1";
const PAGE_SIZE = 100;

async function fetchAll(gFetch, urlBuilder, listKey) {
  const items = [];
  let pageToken;
  do {
    const resp = await gFetch(urlBuilder(pageToken));
    const page = resp[listKey];
    if (Array.isArray(page)) items.push(...page);
    pageToken = resp.nextPageToken || null;
  } while (pageToken);
  return items;
}

// mode "list": just the course id+name list (one bounded call).
async function listCourses(gFetch) {
  const courses = await fetchAll(
    gFetch,
    (pt) => `${CLASSROOM_BASE}/courses?courseStates=ACTIVE&courseStates=ARCHIVED&pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`,
    "courses"
  );
  return courses.map((c) => ({ id: c.id, name: c.name }));
}

// mode "course": fetch ONE course's facets (5 parallel calls), shaped just like
// bundleFromRaw expects for a single course. Bounded to one course so a single
// request stays well under the Edge 10s limit.
async function scrapeOneCourse(gFetch, courseId) {
  const [course] = await fetchAll(
    gFetch,
    (pt) => `${CLASSROOM_BASE}/courses?courseStates=ACTIVE&courseStates=ARCHIVED&pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`,
    "courses"
  ).then((list) => list.filter((c) => c.id === courseId));
  if (!course) throw new Error(`course ${courseId} not found / not accessible`);
  const [topics, courseWork, courseWorkMaterials, announcements, submissions] = await Promise.all([
    fetchAll(gFetch, (pt) => `${CLASSROOM_BASE}/courses/${courseId}/topics?pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`, "topic").catch(() => []),
    fetchAll(gFetch, (pt) => `${CLASSROOM_BASE}/courses/${courseId}/courseWork?pageSize=${PAGE_SIZE}&courseWorkStates=PUBLISHED${pt ? `&pageToken=${pt}` : ""}`, "courseWork").catch(() => []),
    fetchAll(gFetch, (pt) => `${CLASSROOM_BASE}/courses/${courseId}/courseWorkMaterials?pageSize=${PAGE_SIZE}&courseWorkMaterialStates=PUBLISHED${pt ? `&pageToken=${pt}` : ""}`, "courseWorkMaterial").catch(() => []),
    fetchAll(gFetch, (pt) => `${CLASSROOM_BASE}/courses/${courseId}/announcements?pageSize=${PAGE_SIZE}&announcementStates=PUBLISHED${pt ? `&pageToken=${pt}` : ""}`, "announcements").catch(() => []),
    fetchAll(gFetch, (pt) => `${CLASSROOM_BASE}/courses/${courseId}/courseWork/-/studentSubmissions?userId=me&pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`, "studentSubmissions").catch(() => []),
  ]);
  return { courses: [course], courseData: { [courseId]: { topics, courseWork, courseWorkMaterials, announcements, submissions } } };
}
