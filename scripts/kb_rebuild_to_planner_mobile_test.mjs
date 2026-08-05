// Verify switching from the local KB rebuild prompt to Planner clears KB modal state.
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
    const kb = document.getElementById("kbView");
    const onboarding = document.getElementById("kbOnboarding");
    const noteModal = document.getElementById("kbNoteModal");
    const tutorModal = document.getElementById("kbTutorModal");
    if (!kb || !onboarding || !noteModal || !tutorModal) throw new Error("KB rebuild surface is missing");
    kb.hidden = false;
    onboarding.hidden = false;
    noteModal.hidden = false;
    tutorModal.hidden = false;
  });

  await page.locator('.view-toggle-btn[data-view="planner"]').click({ force: true });
  await page.waitForFunction(() => !document.getElementById("plannerView")?.hidden);
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#kbNoteModal").isHidden(), true, "note modal must close when leaving KB");
  assert.equal(await page.locator("#kbOnboarding").isHidden(), false, "rebuild prompt remains recoverable when returning to KB");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ mobile KB rebuild prompt returns cleanly to Planner (${BASE})`);
} finally {
  await browser.close();
}
