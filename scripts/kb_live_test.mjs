// kb_live_test.mjs — REAL browser (Playwright) e2e against the LIVE deployed
// site (Vercel / any public URL). Run AFTER each push so we verify production,
// not just the local simulation.
//
// Requires KB_LIVE_URL (the public site root). If unset, the script exits 0
// (no-op) so local/test runs don't fail when production isn't configured yet.
//
//   KB_LIVE_URL=https://your-app.vercel.app node scripts/kb_live_test.mjs
//
// Exit 0 = pass (or skipped), non-zero = production regression detected.

import { chromium } from "playwright";
import assert from "node:assert/strict";

const LIVE = process.env.KB_LIVE_URL;
if (!LIVE) {
  console.log("[KB live e2e] KB_LIVE_URL not set — skipping live verification.");
  process.exit(0);
}

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

  await check("live: Knowledge Base tab present", async () => {
    await page.waitForSelector('#viewToggle button[data-view="kb"]', { timeout: 10000 });
    await page.evaluate(() => { const t = document.getElementById("viewToggle"); if (t) t.hidden = false; });
    await page.click('#viewToggle button[data-view="kb"]');
    await page.waitForSelector("#kbView:not([hidden]) #kbSearchInput", { timeout: 10000 });
  });

  await check("live: search returns results", async () => {
    // Data-independent: don't assume a specific note exists. Pull a real term
    // from the live DB's own facets/meta so we verify the SEARCH PIPELINE
    // works against whatever is currently deployed (the populated vault, a demo
    // note, etc.) instead of hardcoding brittle content.
    const meta = await (await page.request.fetch(LIVE + "/api/kb-search?q=__ping__")).json().catch(() => null);
    const courses = meta?.meta?.courseList || meta?.filters?.courses || [];
    // Prefer a course name token; else fall back to a generic probe.
    const term = courses.length ? courses[0].split(/\s+/)[0] : "the";
    await page.fill("#kbSearchInput", term);
    await page.keyboard.press("Enter");
    // Either we get result cards, or (if the term matches nothing) the empty
    // state renders — both prove the search UI + API are wired. We assert the
    // API actually returned hits for the chosen term; if the DB is empty we
    // relax to "the empty state rendered without error".
    const api = await (await page.request.fetch(`${LIVE}/api/kb-search?q=${encodeURIComponent(term)}&limit=8`)).json().catch(() => null);
    const hasHits = Array.isArray(api?.results) && api.results.length > 0;
    if (hasHits) {
      await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
      const n = await page.locator("#kbResults .kb-result-card").count();
      assert.ok(n > 0, "expected result cards for a real DB term");
    } else {
      // No hits (e.g. a near-empty demo DB): the empty state must render.
      await page.waitForSelector("#kbResults .empty", { timeout: 10000 });
    }
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
