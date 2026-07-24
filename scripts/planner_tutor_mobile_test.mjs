// planner_tutor_mobile_test.mjs — focused mobile regression for assignment grounding.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 780 }, isMobile: true });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

try {
  const response = await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  assert.ok(response?.ok(), `index should load (HTTP ${response?.status()})`);
  await page.evaluate(() => {
    const ai = document.querySelector("#ai");
    const badge = document.querySelector("#aiGroundingBadge");
    if (!ai || !badge) throw new Error("planner tutor grounding markup is missing");
    ai.hidden = false;
    badge.hidden = false;
    badge.querySelector(".ai-grounding-label").textContent = "Grounded in this assignment";
    badge.querySelector(".ai-grounding-summary").textContent = "Quadratic worksheet · Algebra · 2 attached materials";
    badge.querySelector(".ai-grounding-sources").textContent = "Sources: Quadratic worksheet · Formula sheet · Practice video";
  });
  const badge = page.locator("#aiGroundingBadge");
  assert.equal(await badge.isVisible(), true, "grounding badge should be visible");
  const layout = await badge.evaluate((el) => {
    const summary = el.querySelector(".ai-grounding-summary");
    const sources = el.querySelector(".ai-grounding-sources");
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      summaryDisplay: getComputedStyle(summary).display,
      sourcesDisplay: getComputedStyle(sources).display,
      sourcesWhiteSpace: getComputedStyle(sources).whiteSpace,
      sourcesOverflowWrap: getComputedStyle(sources).overflowWrap,
      summaryWidth: summary.getBoundingClientRect().width,
      sourcesWidth: sources.getBoundingClientRect().width,
    };
  });
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `grounding badge overflows horizontally: ${layout.scrollWidth}px > ${layout.clientWidth}px`);
  assert.equal(layout.summaryDisplay, "block", "assignment summary should occupy its own readable row on mobile");
  assert.equal(layout.sourcesDisplay, "block", "assignment sources should occupy their own readable row on mobile");
  assert.equal(layout.sourcesWhiteSpace, "normal", "assignment sources should wrap instead of clipping on mobile");
  assert.equal(layout.sourcesOverflowWrap, "anywhere", "long assignment source names should wrap safely on mobile");
  assert.ok(layout.summaryWidth <= layout.clientWidth, "assignment summary should fit the badge width");
  assert.ok(layout.sourcesWidth <= layout.clientWidth, "assignment sources should fit the badge width");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ planner tutor mobile grounding badge fits (${layout.clientWidth}px)`);
} finally {
  await browser.close();
}
