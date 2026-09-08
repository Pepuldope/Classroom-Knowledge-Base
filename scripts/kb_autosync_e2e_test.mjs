// kb_autosync_e2e_test.mjs — a stale corpus tops itself up quietly.
//
// Building from Classroom was entirely manual: a button, a card, a minute of
// waiting. That is right for the first build and wrong for a school week. A
// corpus older than a few hours now refreshes itself in the background, with no
// build card and no setting to find.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

const COURSE = { id: "c1", name: "NaE Y3 3.T", section: "2025/26", creationTime: "2025-07-01T00:00:00Z", courseState: "ACTIVE" };

async function run({ generatedAt, expectSync }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const courseListUrls = [];
  await page.route("**/api/oauth-config*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasRefreshTokens: false }) }));
  await page.route("**/api/**", (r) => r.fulfill({ status: 404, body: "{}" }));
  await page.route("**/accounts.google.com/**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("https://classroom.googleapis.com/**", (r) => {
    const url = r.request().url();
    if (url.includes("/courses?")) courseListUrls.push(url);
    const body = url.includes("/courseWork?")
      ? { courseWork: [
          { id: "w1", title: "Pitch", topicId: "t1", state: "PUBLISHED" },
          { id: "w2", title: "Reflection", topicId: "t1", state: "PUBLISHED" },
        ] }
      : url.includes("/topics") ? { topic: [{ topicId: "t1", name: "Sprint 1" }] }
      : url.includes("/courses?") ? { courses: [COURSE] }
      : {};
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(({ generatedAt }) => new Promise((res, rej) => {
    localStorage.setItem("cwa_user_hint", "student@example.edu");
    localStorage.removeItem("cwa_kb_last_sync_attempt");
    const req = indexedDB.open("cwa-archive", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("archive", { keyPath: "id" });
    req.onsuccess = () => {
      const tx = req.result.transaction("archive", "readwrite");
      tx.objectStore("archive").put({ id: "auth-session", token: "test-token", expiresAt: Date.now() + 3600000 });
      // One stale note, so the corpus exists but is out of date.
      tx.objectStore("archive").put({ id: "kb-bundle", data: {
        version: 1, source: "classroom", generatedAt,
        years: ["2025-26"],
        notes: [{ p: "2025-26/vault/NaE Y3 3.T/Sprint 1/Pitch", t: "Pitch", course: "NaE Y3 3.T", y: "2025-26", topic: "Sprint 1", kind: "note", s: "old", x: "old" }],
      } });
      tx.oncomplete = () => { req.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    req.onerror = () => rej(req.error);
  }), { generatedAt });
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(500);
  // Watch for the one visible sign a background sync started.
  await page.evaluate(() => {
    window.__sawSyncing = false;
    const bar = document.getElementById("kbMetaBar");
    const check = () => { if (bar.querySelector(".is-syncing") || bar.classList.contains("is-syncing")) window.__sawSyncing = true; };
    new MutationObserver(check).observe(bar, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  await page.evaluate(() => document.querySelector('.view-toggle-btn[data-view="kb"]')?.click());

  // Read without pinning a version: the page holds its own connection, and
  // naming a version here raced with it.
  const readNotes = () => page.evaluate(() => new Promise((res) => {
    const q = indexedDB.open("cwa-archive");
    q.onerror = () => res(-1);
    q.onsuccess = () => {
      const db = q.result;
      const tx = db.transaction("archive", "readonly");
      const get = tx.objectStore("archive").get("kb-bundle");
      get.onsuccess = () => { res(get.result?.data?.notes?.length ?? 0); db.close(); };
      get.onerror = () => { res(-1); db.close(); };
    };
  }));

  let notes = await readNotes();
  const deadline = Date.now() + (expectSync ? 15000 : 3000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    notes = await readNotes();
    if (expectSync && notes >= 2) break;
  }

  const buildCardShown = await page.evaluate(() => {
    const p = document.getElementById("kbBuildPanel");
    return !!p && !p.hidden;
  });
  const sawSyncing = await page.evaluate(() => window.__sawSyncing === true);
  await page.close();
  return { notes, buildCardShown, courseListUrls, sawSyncing };
}

try {
  // Stale by a day: tops itself up, silently.
  const stale = await run({ generatedAt: new Date(Date.now() - 24 * 3600_000).toISOString(), expectSync: true });
  assert.ok(stale.notes >= 2, `stale corpus should have picked up the new assignment, has ${stale.notes} notes`);
  assert.equal(stale.buildCardShown, false, "a background top-up must not raise the build card");
  assert.equal(stale.sawSyncing, true, "a background sync should have visibly started");
  // The BUILD reads ACTIVE courses only — an archived course is closed, and
  // re-reading it every few hours is most of the request budget spent to learn
  // nothing. (The "new courses" banner separately lists both states; that is one
  // cheap call and is not what this asserts.)
  const activeOnly = stale.courseListUrls.filter((u) => !u.includes("courseStates=ARCHIVED"));
  const withArchived = stale.courseListUrls.filter((u) => u.includes("courseStates=ARCHIVED"));
  assert.ok(activeOnly.length > 0, `expected an ACTIVE-only course listing, got: ${stale.courseListUrls.join(" | ")}`);
  assert.ok(withArchived.length <= 1,
    `only the new-course check should list archived courses, saw ${withArchived.length} such calls`);

  // Synced an hour ago: left alone entirely.
  const fresh = await run({ generatedAt: new Date(Date.now() - 3600_000).toISOString(), expectSync: false });
  assert.equal(fresh.notes, 1, "a fresh corpus must not be rebuilt");
  assert.equal(fresh.sawSyncing, false, "a fresh corpus must not start a background sync");
  // The Planner fetches courses on sign-in regardless; what must not happen is
  // a second, KB-driven build on top of it.
  assert.ok(fresh.courseListUrls.length <= 3,
    `a fresh corpus should not add course listings of its own, saw ${fresh.courseListUrls.length}`);

  console.log("✓ stale corpus syncs in the background (ACTIVE courses only, no build card); fresh corpus is left alone");
} finally {
  await browser.close();
}
