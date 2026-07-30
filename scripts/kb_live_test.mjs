// kb_live_test.mjs — REAL browser (Playwright) e2e against the LIVE deployed
// site (Vercel / any public URL). Run AFTER each push so we verify production,
// not just the local simulation.
//
// Default target is the production alias (same as seed-vault / visual audits).
// Override with KB_LIVE_URL; skip intentionally with KB_SKIP_LIVE=1.
//
//   node scripts/kb_live_test.mjs
//   KB_LIVE_URL=https://your-preview.vercel.app node scripts/kb_live_test.mjs
//   KB_SKIP_LIVE=1 node scripts/kb_live_test.mjs
//
// Exit 0 = pass (or skipped), non-zero = production regression detected.

import { chromium } from "playwright";
import assert from "node:assert/strict";

const DEFAULT_LIVE = "https://classroom-knowledge-google.vercel.app";
const skipLive =
  process.env.KB_SKIP_LIVE === "1" ||
  process.env.KB_SKIP_LIVE === "true" ||
  process.env.KB_LIVE_URL === "skip";
if (skipLive) {
  console.log("[KB live e2e] KB_SKIP_LIVE set — skipping live verification.");
  process.exit(0);
}
const LIVE = (process.env.KB_LIVE_URL || DEFAULT_LIVE).replace(/\/$/, "");

const results = [];
function check(name, fn) {
  return (async () => {
    try { await fn(); results.push(["PASS", name]); console.log(`  ✓ ${name}`); }
    catch (e) { results.push(["FAIL", name, e.message]); console.error(`  ✗ ${name}\n      ${e.message}`); }
  })();
}

console.log(`\n[KB live e2e] against ${LIVE}\n`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

try {
  await check("live site loads", async () => {
    const res = await page.goto(LIVE, { waitUntil: "networkidle", timeout: 30000 });
    assert.ok(res && res.ok(), `HTTP ${res && res.status()}`);
  });

  await check("live: Knowledge Base tab present and private", async () => {
    await page.waitForSelector('#viewToggle button[data-view="kb"]', { timeout: 10000 });
    await page.evaluate(() => { const t = document.getElementById("viewToggle"); if (t) t.hidden = false; });
    await page.click('#viewToggle button[data-view="kb"]');
    await page.waitForFunction(() => document.getElementById("kbView")?.hidden === true, null, { timeout: 10000 });
    assert.match(await page.locator("#status").textContent(), /Sign in with Google/);
  });

  await check("live: compatibility search API returns results", async () => {
    // Data-independent: don't assume a specific note exists. Pull a real term
    // from the live DB's own facets/meta so we verify the SEARCH PIPELINE
    // works against whatever is currently deployed (the populated vault, a demo
    // note, etc.) instead of hardcoding brittle content.
    const meta = await (await page.request.fetch(LIVE + "/api/kb-search?q=__ping__")).json().catch(() => null);
    const courses = meta?.meta?.courseList || meta?.filters?.courses || [];
    // courseList entries are objects {name,y,family,noteCount}; filters.courses
    // are plain strings. Normalize to a course-name string either way.
    const first = courses[0];
    const firstName = typeof first === "string" ? first : (first && first.name) || "";
    // Prefer a course name token; else fall back to a generic probe.
    const term = firstName ? firstName.split(/\s+/)[0] : "the";
    const api = await (await page.request.fetch(`${LIVE}/api/kb-search?q=${encodeURIComponent(term)}&limit=8`)).json().catch(() => null);
    const hasHits = Array.isArray(api?.results) && api.results.length > 0;
    assert.ok(hasHits, `expected populated compatibility search for ${term}`);
    assert.ok(Number(api?.meta?.noteCount) > 100, "expected a realistic populated note count");
  });

  await check("live: no uncaught page errors", async () => {
    assert.equal(pageErrors.length, 0, "page errors: " + pageErrors.join(" | "));
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n[KB live e2e] ${results.length - failed.length}/${results.length} passed.`);
if (failed.length) {
  console.error("LIVE REGRESSION:");
  for (const f of failed) console.error(`  - ${f[1]}: ${f[2]}`);
  process.exit(1);
}
console.log("Live e2e OK");
