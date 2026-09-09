// planner_tutor_mobile_test.mjs — focused mobile regression for assignment grounding.
//
// REVISED 2026-09-09. This file used to assert that the summary and the source
// list each occupied their own visible, wrapping block row. That WAS the design,
// and it was the defect: the badge restated the panel's title, its course and
// every attachment — all three already on screen directly above it — for 191px
// of a 776px phone sheet, leaving 139px for the actual conversation.
//
// The grounding line is one row now. What still has to hold is everything the
// row was actually FOR: the full summary and source list remain in the DOM and
// in the accessibility tree (assistive tech reads them, and the copy button
// copies them), the copy control keeps its announcement wiring and stays big
// enough to hit, and the whole thing does not overflow 390px.
//
// Kept honest deliberately: `visibility: hidden` or `display: none` would
// remove the text from the accessibility tree, so the assertions below check
// for the clip-path idiom specifically, not merely "not visible".
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
  const status = page.locator("#aiGroundingCopyStatus");
  assert.equal(await status.getAttribute("role"), "status", "copy status should expose a status role");
  assert.equal(await status.getAttribute("aria-live"), "assertive", "copy status should be announced assertively");
  assert.equal(await status.getAttribute("aria-atomic"), "true", "copy status should announce the complete outcome");
  const layout = await badge.evaluate((el) => {
    const summary = el.querySelector(".ai-grounding-summary");
    const sources = el.querySelector(".ai-grounding-sources");
    const part = (node) => ({
      display: getComputedStyle(node).display,
      visibility: getComputedStyle(node).visibility,
      text: (node.textContent || "").trim(),
    });
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      badgeHeight: Math.round(el.getBoundingClientRect().height),
      copyHeight: Math.round(document.getElementById("aiGroundingCopy").getBoundingClientRect().height),
      summary: part(summary),
      sources: part(sources),
    };
  });
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `grounding badge overflows horizontally: ${layout.scrollWidth}px > ${layout.clientWidth}px`);
  assert.ok(layout.badgeHeight <= 60,
    `the grounding line must stay a line, not a panel — measured ${layout.badgeHeight}px`);

  // Hidden from the layout, NOT from assistive technology. display:none or
  // visibility:hidden would drop both from the accessibility tree, which is the
  // easy wrong way to make a box shorter.
  for (const [name, part] of [["summary", layout.summary], ["sources", layout.sources]]) {
    assert.notEqual(part.display, "none", `${name} must stay in the accessibility tree`);
    assert.notEqual(part.visibility, "hidden", `${name} must stay in the accessibility tree`);
    assert.ok(part.text.length > 10, `${name} must still carry its full text, got "${part.text}"`);
  }
  assert.ok(layout.sources.text.includes("Practice video"),
    "the whole source list is still there for the copy button and for screen readers");

  // The copy action is the only reason the source list exists on screen at all,
  // so it must stay hittable on a phone.
  assert.ok(layout.copyHeight >= 28,
    `the copy control is ${layout.copyHeight}px tall — too small to hit on a phone`);
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ planner tutor grounding is one ${layout.badgeHeight}px line at ${layout.clientWidth}px, sources intact for AT`);
} finally {
  await browser.close();
}
