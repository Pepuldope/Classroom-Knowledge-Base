// continuity_smoke_test.mjs — verify the shared shell can move between every
// major view after KB code changes without a page crash or dead surface.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));

try {
  const response = await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  assert.ok(response?.ok(), `index should load (HTTP ${response?.status()})`);

  await page.waitForSelector("#viewToggle:not([hidden])", { timeout: 10000 });
  const navViews = await page.locator(".view-toggle-btn").evaluateAll((buttons) => buttons.map((button) => button.dataset.view).sort());
  assert.deepEqual(navViews, ["archive", "kb", "planner"], "shared navigation should expose planner, archive, and KB");

  await page.locator('.view-toggle-btn[data-view="kb"]').click();
  assert.equal(await page.locator("#kbView").isHidden(), true, "signed-out users must not open the private KB");
  assert.match(await page.locator("#status").textContent(), /Sign in with Google/);

  // Archive is private too: clicking it while signed out must keep the
  // previous public surface visible rather than exposing Classroom data.
  await page.locator('.view-toggle-btn[data-view="archive"]').click();
  assert.equal(await page.locator("#archiveView").isHidden(), true, "signed-out users must not open the private Archive");
  assert.match(await page.locator("#status").textContent(), /Sign in with Google/);

  await page.locator('.view-toggle-btn[data-view="planner"]').click();
  await page.waitForFunction(() => {
    const el = document.getElementById("plannerView");
    return el && !el.hidden;
  }, { timeout: 10000 });
  assert.equal(await page.locator("#plannerView").isVisible(), true, "planner view should be visible");

  // Settings is account-gated in the real shell. Open its existing modal in a
  // DOM-backed way so this smoke remains deterministic without OAuth secrets.
  const settings = await page.evaluate(() => {
    const modal = document.getElementById("settingsModal");
    const pane = document.querySelector('[data-pane="knowledge-base"]');
    if (!modal || !pane) return { modal: false, pane: false };
    modal.hidden = false;
    pane.hidden = false;
    return { modal: !modal.hidden, pane: !pane.hidden };
  });
  assert.deepEqual(settings, { modal: true, pane: true }, "existing Settings modal should contain a KB pane");
  assert.equal(await page.locator("#settingsModal").isVisible(), true, "Settings modal should be visible");
  assert.equal(await page.locator('[data-pane="knowledge-base"]').isVisible(), true, "Knowledge Base Settings pane should be visible");
  await page.locator("#settingsClose").click();
  assert.equal(await page.locator("#settingsModal").isHidden(), true, "Settings should close cleanly");
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  console.log(`✓ continuity smoke passed (${BASE})`);
} finally {
  await browser.close();
}
