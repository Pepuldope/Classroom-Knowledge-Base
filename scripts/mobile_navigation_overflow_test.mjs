// mobile_navigation_overflow_test.mjs — shared navigation stays usable after a long KB result is opened.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  const data = await page.evaluate(() => {
    const header = document.querySelector("header");
    const toggle = document.getElementById("viewToggle");
    if (!header || !toggle) throw new Error("shared header/navigation is missing");
    toggle.hidden = false;
    toggle.setAttribute("aria-label", "Study views");
    const first = toggle.querySelector('[data-view="kb"]');
    if (first) first.textContent = "Knowledge Base — Long Result";
    const rect = toggle.getBoundingClientRect();
    return {
      viewport: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      headerScrollWidth: header.scrollWidth,
      headerClientWidth: header.clientWidth,
      toggleScrollWidth: toggle.scrollWidth,
      toggleClientWidth: toggle.clientWidth,
      toggleOverflowX: getComputedStyle(toggle).overflowX,
      toggleWidth: rect.width,
      toggleVisible: rect.width > 0 && rect.height > 0,
    };
  });

  assert.equal(data.toggleVisible, true, "mobile view navigation should remain visible");
  assert.ok(data.pageScrollWidth <= data.viewport + 1, `page overflows after long KB result: ${data.pageScrollWidth}px > ${data.viewport}px`);
  assert.ok(data.headerScrollWidth <= data.headerClientWidth + 1, `header contents overflow: ${data.headerScrollWidth}px > ${data.headerClientWidth}px`);
  assert.ok(["auto", "scroll"].includes(data.toggleOverflowX), `view navigation should scroll safely, got overflow-x=${data.toggleOverflowX}`);
  assert.ok(data.toggleScrollWidth > data.toggleClientWidth + 1, "long navigation label should overflow inside the switcher scroll area");
  console.log(`✓ mobile navigation stays scroll-safe at ${data.viewport}px`);
} finally {
  await browser.close();
}
