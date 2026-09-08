// assignment_panel_close_test.mjs — you can always get out of the assignment
// panel, on a desktop and on a phone.
//
// Regression: the panel is `position: fixed; top: 0` at z-index 50, and the
// page header became sticky at z-index 80. The header then painted over the
// panel's top strip — close button included — so on desktop the only way out
// was clicking the assignment again, and on a phone there was no way out.
//
// A second cause underneath it: the page header's rules were written as a bare
// `header` element selector, so `display: grid; grid-template-columns: 1fr auto
// 1fr` also applied to this panel's <header>, parking its close button in the
// middle column instead of the top right.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

const openPanel = (page) => page.evaluate(() => {
  document.getElementById("viewToggle").hidden = false;
  document.getElementById("menuWrap").hidden = false;
  const panel = document.getElementById("ai");
  panel.hidden = false;
  document.getElementById("aiTitle").textContent = "Prepare pitch deck for the client review";
});

try {
  for (const [label, w, h] of [["desktop", 1280, 900], ["phone", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
    await openPanel(page);
    await page.waitForTimeout(350); // the phone sheet animates up

    const geom = await page.evaluate(() => {
      const close = document.getElementById("aiClose");
      const panel = document.getElementById("ai");
      const header = document.querySelector("body > header");
      const c = close.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      // What is actually on top at the close button's centre?
      const hit = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
      return {
        close: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height), right: Math.round(c.right) },
        panel: { x: Math.round(p.x), right: Math.round(p.right), top: Math.round(p.top) },
        headerZ: getComputedStyle(header).zIndex,
        panelZ: getComputedStyle(panel).zIndex,
        hitId: hit ? (hit.id || hit.tagName) : null,
        coveredByHeader: !!(hit && hit.closest && hit.closest("body > header")),
      };
    });

    assert.ok(Number(geom.panelZ) > Number(geom.headerZ),
      `${label}: panel (z ${geom.panelZ}) must sit above the page header (z ${geom.headerZ})`);
    assert.equal(geom.coveredByHeader, false, `${label}: the page header is covering the close button`);
    assert.equal(geom.hitId, "aiClose", `${label}: the close button is not the top element at its own centre (got ${geom.hitId})`);
    // Top-right of the panel, not floating in the middle of it.
    assert.ok(geom.close.right >= geom.panel.right - 40,
      `${label}: close button should be at the panel's right edge (button right ${geom.close.right}, panel right ${geom.panel.right})`);
    assert.ok(geom.close.w >= 44 && geom.close.h >= 44,
      `${label}: close button is ${geom.close.w}x${geom.close.h}, below the 44px touch target`);

    // It actually closes, by click...
    await page.locator("#aiClose").click();
    assert.equal(await page.locator("#ai").isHidden(), true, `${label}: clicking × did not close the panel`);

    // ...and by Escape.
    await openPanel(page);
    await page.waitForTimeout(350);
    assert.equal(await page.locator("#ai").isHidden(), false, `${label}: panel should have reopened`);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#ai").isHidden(), true, `${label}: Escape did not close the panel`);

    console.log(`✓ ${label}: close button reachable at the panel's top right (${geom.close.w}x${geom.close.h}), closes on click and Escape`);
    await page.close();
  }
} finally {
  await browser.close();
}
