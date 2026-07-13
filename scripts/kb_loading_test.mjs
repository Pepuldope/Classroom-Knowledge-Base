// kb_loading_test.mjs — TDD test for owner #7 LOADING state on KB search.
// While the /api/kb-search fetch is in flight the UI must show an intentional
// "searching" spinner (not a blank/stale region); it must disappear once
// results arrive. Verified by intercepting the search route to add latency.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "https://classroom-knowledge-google.vercel.app";
const PATH = process.env.KB_PATH || "/kb-test-harness.html";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const results = [];
function check(name, fn) {
  return (async () => {
    try { await fn(); results.push(["PASS", name]); console.log(`  ✓ ${name}`); }
    catch (e) { results.push(["FAIL", name, e.message]); console.error(`  ✗ ${name}\n      ${e.message}`); }
  })();
}

try {
  console.log(`\n[KB loading-state e2e] against ${BASE}${PATH}\n`);
  await page.goto(BASE + PATH, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForSelector("#kbView:not([hidden])", { timeout: 10000 });
  await page.waitForSelector("#kbSearchInput", { timeout: 10000 });
  await page.waitForTimeout(800);

  // Slow the search route so the in-flight loading state is observable.
  await page.route("**/api/kb-search**", async (route) => {
    await new Promise((r) => setTimeout(r, 1400));
    await route.fallback();
  });

  await check("a loading spinner appears while the search is in flight", async () => {
    await page.fill("#kbSearchInput", "algebra");
    await page.click("#kbSearchInput");
    await page.keyboard.press("Enter");
    // Assert the spinner shows up during the (delayed) round-trip.
    await page.waitForSelector("#kbResults .kb-loading, #kbLoading:not([hidden]), .kb-loading-spinner", { timeout: 3000 });
  });

  await check("the loading spinner clears and results render after the fetch", async () => {
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 8000 });
    const spinnerGone =
      (await page.locator("#kbResults .kb-loading").count()) === 0 &&
      (await page.locator(".kb-loading-spinner").count()) === 0;
    assert.ok(spinnerGone, "loading spinner must be removed after results arrive");
    const n = await page.locator("#kbResults .kb-result-card").count();
    assert.ok(n > 0, "results should render after the delayed search");
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
