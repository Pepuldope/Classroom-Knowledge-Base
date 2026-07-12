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
    await page.fill("#kbSearchInput", "cover letter");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
    const n = await page.locator("#kbResults .kb-result-card").count();
    assert.ok(n > 0, "expected results on live site");
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
