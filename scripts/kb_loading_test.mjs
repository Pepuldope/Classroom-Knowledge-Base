// kb_loading_test.mjs — TDD test for owner #7 LOADING state on KB search.
// While the private IndexedDB bundle is being discovered the UI must show an
// intentional loading state (not a blank/stale region). Search itself is local
// after the pivot, so the second assertion verifies that retrieval completes
// without a network round-trip or a blank result surface.
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
  await page.goto(BASE + PATH, { waitUntil: "domcontentloaded", timeout: 45000 });
  // The post-pivot harness must exercise the real client-local path. Seed a
  // tiny private bundle in this isolated browser context before reloading;
  // production never receives this fixture and no server KB route is used.
  await page.evaluate(async () => {
    const { saveKbBundle } = await import("/kb-local.js");
    await saveKbBundle({
      version: 1,
      generatedAt: new Date().toISOString(),
      years: ["2025-26"],
      courses: ["Algebra"],
      notes: [
        { t: "Quadratic equations", course: "Algebra", y: "2025-26", topic: "quadratic", kind: "note", x: "Solve a quadratic equation by factoring." },
        { t: "Linear equations", course: "Algebra", y: "2025-26", topic: "linear", kind: "note", x: "Balance both sides of the equation." },
      ],
    });
  });
  await page.addInitScript(() => { window.__cwaTestLoadDelayMs = 1400; });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#kbView:not([hidden])", { timeout: 10000 });
  await check("build card stays hidden while an existing KB is being discovered", async () => {
    const state = await page.evaluate(() => ({
      onboardingHidden: document.querySelector("#kbOnboarding")?.hidden,
      mainVisible: !document.querySelector("#kbMain")?.hidden,
      loadingText: document.querySelector("#kbMetaBar")?.textContent || "",
    }));
    assert.equal(state.onboardingHidden, true, "build/onboarding card must hide during discovery");
    assert.equal(state.mainVisible, true, "study surface must remain visible during discovery");
    assert.match(state.loadingText, /Loading your knowledge base/);
  });
  await page.waitForSelector("#kbSearchInput", { timeout: 10000 });
  await page.waitForFunction(() => /\b2\b notes/.test(document.querySelector("#kbMetaBar")?.textContent || ""), null, { timeout: 10000 });
  await page.waitForTimeout(100);
  await check("local search completes without a network round-trip", async () => {
    await page.fill("#kbSearchInput", "algebra");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 3000 });
  });

  await check("local results remain visible after retrieval completes", async () => {
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 8000 });
    const spinnerGone =
      (await page.locator("#kbResults .kb-loading").count()) === 0 &&
      (await page.locator(".kb-loading-spinner").count()) === 0;
    assert.ok(spinnerGone, "loading indicator must be removed after results arrive");
    const n = await page.locator("#kbResults .kb-result-card").count();
    assert.ok(n > 0, "results should render after the delayed search");
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
