// Verify mobile Settings navigation still reaches the local KB rebuild state
// after clearing a populated bundle through the real Settings control.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(() => {
    const menuWrap = document.getElementById("menuWrap");
    const menuBtn = document.getElementById("menuBtn");
    const settingsBtn = document.getElementById("settingsBtn");
    if (!menuWrap || !menuBtn || !settingsBtn) throw new Error("mobile Settings controls are missing");
    menuWrap.hidden = false;
    menuBtn.hidden = false;
    menuBtn.style.display = "block";
    settingsBtn.hidden = false;
    settingsBtn.style.display = "block";
  });

  await page.locator("#menuBtn").click();
  await page.locator("#settingsBtn").click();
  await page.locator("#settingsTab-knowledge-base").click();
  await page.waitForFunction(() => {
    const pane = document.querySelector('[data-pane="knowledge-base"]');
    return !!pane && !pane.hidden;
  }, null, { timeout: 10000 });

  await page.evaluate(async () => {
    const local = await import("/kb-local.js");
    await local.saveKbBundle({
      version: 1,
      generatedAt: "2026-08-04T00:00:00.000Z",
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
  assert.equal(await page.locator("#kbOnboarding").isHidden(), false, "clear should reveal the rebuild card");

  await page.locator("#settingsClose").click();
  await page.locator("#menuBtn").click();
  assert.equal(await page.locator("#menuPopover").isVisible(), true, "mobile menu should reopen after the KB clear");
  await page.locator("#settingsBtn").click();
  await page.locator("#settingsTab-knowledge-base").click();
  await page.waitForFunction(() => {
    const pane = document.querySelector('[data-pane="knowledge-base"]');
    return !!pane && !pane.hidden;
  }, null, { timeout: 10000 });
  assert.equal(await page.locator("#kbPrefClear").isVisible(), true, "KB Settings controls should remain reachable on mobile");
  assert.match(await page.locator("#kbPrefStatus").textContent(), /cleared/i);
  assert.equal(await page.locator("#kbOnboarding").isHidden(), false, "rebuild card should remain visible after reopening mobile Settings");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ mobile Settings reaches KB rebuild state (${BASE})`);
} finally {
  await browser.close();
}
