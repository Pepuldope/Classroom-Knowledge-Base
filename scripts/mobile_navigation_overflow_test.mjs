// mobile_navigation_overflow_test.mjs — the Planner|Study switcher stays usable
// and inside the viewport on a phone, even with an absurdly long label.
//
// This used to assert the switcher was a horizontal SCROLL region
// (overflow-x: auto, with a long label overflowing inside it). That was the
// mechanism of the old design, not the requirement — and it was the direct
// cause of the bug the owner reported: the container stretched to the full
// header width while its buttons kept their natural width, leaving a
// full-width box with both labels jammed against the left edge.
//
// The requirement is what is asserted now: the page and header never overflow,
// the switcher never overflows itself, and its two segments split the width
// evenly with real touch targets.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });

  const measure = async (label) => page.evaluate((label) => {
    const header = document.querySelector("header");
    const toggle = document.getElementById("viewToggle");
    if (!header || !toggle) throw new Error("shared header/navigation is missing");
    toggle.hidden = false;
    const buttons = [...toggle.querySelectorAll(".view-toggle-btn")];
    if (label !== null) {
      const kb = toggle.querySelector('[data-view="kb"] .view-toggle-text')
        || toggle.querySelector('[data-view="kb"]');
      kb.textContent = label;
    }
    const rect = toggle.getBoundingClientRect();
    return {
      viewport: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      headerScrollWidth: header.scrollWidth,
      headerClientWidth: header.clientWidth,
      toggleScrollWidth: toggle.scrollWidth,
      toggleClientWidth: toggle.clientWidth,
      toggleWidth: rect.width,
      toggleVisible: rect.width > 0 && rect.height > 0,
      buttonWidths: buttons.map((b) => Math.round(b.getBoundingClientRect().width)),
      buttonHeights: buttons.map((b) => Math.round(b.getBoundingClientRect().height)),
      buttonLefts: buttons.map((b) => Math.round(b.getBoundingClientRect().left)),
    };
  }, label);

  for (const [name, label] of [
    ["default labels", null],
    ["absurdly long label", "Knowledge Base — Long Result That Keeps Going And Going Well Past The Viewport"],
  ]) {
    const d = await measure(label);
    assert.equal(d.toggleVisible, true, `${name}: switcher should remain visible`);
    assert.ok(d.pageScrollWidth <= d.viewport + 1, `${name}: page overflows (${d.pageScrollWidth}px > ${d.viewport}px)`);
    assert.ok(d.headerScrollWidth <= d.headerClientWidth + 1, `${name}: header contents overflow (${d.headerScrollWidth}px > ${d.headerClientWidth}px)`);
    // Stronger than the old assertion: the label is truncated inside its own
    // half, so there is nothing to scroll to in the first place.
    assert.ok(d.toggleScrollWidth <= d.toggleClientWidth + 1, `${name}: switcher overflows itself (${d.toggleScrollWidth}px > ${d.toggleClientWidth}px)`);

    assert.equal(d.buttonWidths.length, 2, `${name}: expected exactly two segments`);
    const [a, b] = d.buttonWidths;
    assert.ok(Math.abs(a - b) <= 1, `${name}: segments should be equal width, got ${a}px and ${b}px`);
    // The reported bug: a full-width box with both buttons packed on the left.
    assert.ok(a + b >= d.toggleClientWidth - 14, `${name}: segments should fill the switcher, got ${a + b}px inside ${d.toggleClientWidth}px`);
    assert.ok(d.buttonLefts[1] > d.buttonLefts[0] + a - 2, `${name}: the second segment should start where the first ends`);
    for (const h of d.buttonHeights) {
      assert.ok(h >= 44, `${name}: touch target too small (${h}px, want >= 44px)`);
    }
  }

  const final = await measure(null);
  console.log(`✓ mobile Planner|Study switcher splits ${final.toggleClientWidth}px evenly at ${final.viewport}px`);
} finally {
  await browser.close();
}
