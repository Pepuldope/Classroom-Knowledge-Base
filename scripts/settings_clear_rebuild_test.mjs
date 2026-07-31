// Verify clearing the local KB from Settings immediately returns the KB to its
// honest empty/rebuild state without touching the raw archive.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.route("**/api/kb-search**", (route) => route.fulfill({
status: 200,
contentType: "application/json",
body: JSON.stringify({ results: [], filters: { courses: [], years: [], kinds: [], families: [] }, meta: { noteCount: 0 }, empty: true }),
}));

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(() => {
    const menu = document.getElementById("menuPopover");
    const button = document.getElementById("menuBtn");
    const settings = document.getElementById("settingsBtn");
    if (menu) menu.hidden = false;
    if (button) { button.hidden = false; button.style.display = "block"; }
    if (settings) { settings.hidden = false; settings.style.display = "block"; }
  });
  await page.evaluate(() => document.getElementById("settingsBtn")?.click());
  await page.waitForFunction(() => !document.getElementById("settingsModal")?.hidden);
  await page.locator("#settingsTab-knowledge-base").click();
  await page.waitForFunction(() => !document.querySelector('[data-pane="knowledge-base"]')?.hidden);

  await page.evaluate(async () => {
    const local = await import("/kb-local.js");
    await local.saveKbBundle({
      version: 1,
      generatedAt: "2026-07-31T00:00:00.000Z",
      years: [2026],
      courses: ["Algebra"],
      notes: [{ t: "Quadratics", course: "Algebra", y: 2026, topic: "Equations", kind: "note", s: "Study quadratics", x: "x", p: "seed.md" }],
    });
    const kb = await import("/kb.js");
    kb.showKbView();
  });
  await page.waitForFunction(() => document.getElementById("kbOnboarding")?.hidden === true);
  await page.locator("#kbPrefClear").click();
  await page.waitForFunction(() => document.getElementById("kbPrefStatus")?.textContent.includes("cleared"));

  assert.equal(await page.locator("#kbOnboarding").isHidden(), false, "clearing the local KB should reveal the rebuild card");
  assert.equal(await page.locator("#kbBuildPanel").isHidden(), true, "clearing should not leave the build progress panel open");
  assert.match(await page.locator("#kbBuildHint").textContent(), /Sign in to build|build/i);
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ Settings clear returns the KB to its rebuild state (${BASE})`);
} finally {
  await browser.close();
}
