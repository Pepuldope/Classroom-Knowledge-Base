// sidebar_overlap_test.mjs — the centred column never runs under the fixed
// account card in the bottom-left corner.
//
// The column used to be capped at 900px, which happened to clear the card on a
// large monitor. Widening it to `min(96vw, 1560px)` put its left edge at 29px
// on a 1440px screen while the card ends at 216px, so page content slid under
// it. The card itself is fine and is not touched: the column is what gives way.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

// The card is displayed from 901px up; below that it is display:none.
const WITH_CARD = [1920, 1600, 1440, 1280, 1100, 960];
const WITHOUT_CARD = [900, 768, 390];

try {
  for (const width of WITH_CARD) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
    const m = await page.evaluate(() => {
      document.getElementById("sidebar").hidden = false;
      const card = document.getElementById("sidebar").getBoundingClientRect();
      const main = document.querySelector("main");
      const box = main.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(main).paddingLeft);
      return {
        cardRight: card.right,
        cardDisplayed: getComputedStyle(document.getElementById("sidebar")).display !== "none",
        contentLeft: box.left + pad,
        mainWidth: box.width,
        viewport: document.documentElement.clientWidth,
      };
    });
    assert.equal(m.cardDisplayed, true, `${width}px: the card should be shown here`);
    assert.ok(m.contentLeft >= m.cardRight,
      `${width}px: content starts at ${Math.round(m.contentLeft)} but the card ends at ${Math.round(m.cardRight)}`);
    // ...and no narrower than it has to be: widening by 24px more would collide.
    assert.ok(m.contentLeft <= m.cardRight + 40,
      `${width}px: column is needlessly narrow — ${Math.round(m.contentLeft - m.cardRight)}px of dead space beside the card`);
    assert.ok(m.mainWidth > 400, `${width}px: column collapsed to ${Math.round(m.mainWidth)}px`);
    await page.close();
  }

  for (const width of WITHOUT_CARD) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
    const m = await page.evaluate(() => {
      const sb = document.getElementById("sidebar");
      sb.hidden = false;
      const box = document.querySelector("main").getBoundingClientRect();
      return {
        cardDisplayed: getComputedStyle(sb).display !== "none",
        mainWidth: box.width,
        viewport: document.documentElement.clientWidth,
      };
    });
    assert.equal(m.cardDisplayed, false, `${width}px: the card should be hidden here`);
    // With no card there is nothing to clear, so the column keeps its width.
    assert.ok(m.mainWidth >= Math.min(m.viewport * 0.9, m.viewport - 40),
      `${width}px: no card here, so the column should not be narrowed (got ${Math.round(m.mainWidth)} of ${m.viewport})`);
    await page.close();
  }

  console.log(`✓ centred column clears the account card at ${WITH_CARD.join(", ")}px and keeps full width at ${WITHOUT_CARD.join(", ")}px`);
} finally {
  await browser.close();
}
