// sticky_header_test.mjs — the top bar stays on screen while the page scrolls.
//
// It carries the Planner|Study switcher, the app title and the account menu, so
// it should never be a scroll away. Anything else that sticks to the viewport
// top has to clear it, which is what --header-h is for.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

try {
  for (const [label, width, height] of [["desktop", 1280, 800], ["phone", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
    await page.evaluate(() => {
      document.getElementById("viewToggle").hidden = false;
      document.getElementById("menuWrap").hidden = false;
      // Enough content to scroll past.
      const main = document.querySelector("main");
      const filler = document.createElement("div");
      filler.style.height = "3000px";
      main.appendChild(filler);
    });
    await page.waitForTimeout(150);

    const before = await page.evaluate(() => {
      const h = document.querySelector("header").getBoundingClientRect();
      return { top: Math.round(h.top), height: Math.round(h.height) };
    });
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => {
      const h = document.querySelector("header").getBoundingClientRect();
      const toggle = document.getElementById("viewToggle").getBoundingClientRect();
      return {
        top: Math.round(h.top),
        height: Math.round(h.height),
        scrollY: Math.round(window.scrollY),
        toggleVisible: toggle.top >= 0 && toggle.bottom <= window.innerHeight,
        headerVar: getComputedStyle(document.documentElement).getPropertyValue("--header-h").trim(),
        zIndex: getComputedStyle(document.querySelector("header")).zIndex,
        position: getComputedStyle(document.querySelector("header")).position,
      };
    });

    assert.ok(after.scrollY > 500, `${label}: the page should have scrolled, got ${after.scrollY}`);
    assert.equal(after.position, "sticky", `${label}: header should be sticky`);
    assert.equal(after.top, 0, `${label}: header left the viewport (top ${after.top}px after scrolling)`);
    assert.equal(after.toggleVisible, true, `${label}: the view switcher must stay reachable`);
    assert.equal(after.height, before.height, `${label}: header height changed on scroll`);
    assert.equal(after.headerVar, `${after.height}px`, `${label}: --header-h (${after.headerVar}) must match the real header height (${after.height}px)`);
    // Below modals (100) so an overlay still covers it; above the sidebar (40),
    // tutor panel (50) and dropdowns (60).
    assert.ok(Number(after.zIndex) > 60 && Number(after.zIndex) < 100,
      `${label}: header z-index ${after.zIndex} should sit above page chrome but below modals`);
    // A header eating the screen on a phone is its own bug.
    assert.ok(after.height <= height * 0.25,
      `${label}: header takes ${after.height}px of a ${height}px viewport (${Math.round(after.height / height * 100)}%)`);

    // The switcher's labels must be fully readable, not ellipsised. Its segments
    // are `flex: 1 1 0`, so they have no content width of their own and the
    // container's floor is the only thing holding them open — a floor that had
    // silently stopped applying on desktop, rendering "Planner" as "Plan...".
    const labels = await page.evaluate(() => [...document.querySelectorAll(".view-toggle-text")].map((el) => ({
      text: el.textContent,
      truncated: el.scrollWidth > el.clientWidth + 1,
    })));
    assert.equal(labels.length, 2, `${label}: expected two switcher labels`);
    for (const l of labels) {
      assert.equal(l.truncated, false, `${label}: switcher label "${l.text}" is truncated`);
    }

    console.log(`✓ ${label}: header stays pinned at top:0, ${after.height}px (${Math.round(after.height / height * 100)}% of viewport), labels intact`);
    await page.close();
  }
} finally {
  await browser.close();
}
