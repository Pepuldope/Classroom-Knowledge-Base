// kb_result_card_focus_test.mjs — long-label result cards keep a deliberate keyboard focus ring.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

try {
  await page.goto(`${BASE}/kb-test-harness.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#kbView:not([hidden])", { timeout: 10000 });
  const focus = await page.evaluate(() => {
    const kbMain = document.getElementById("kbMain");
    const results = document.getElementById("kbResults");
    if (!kbMain || !results) throw new Error("KB results surface is missing");
    kbMain.hidden = false;
    results.hidden = false;
    results.innerHTML = `
      <div class="assignment kb-result-card" tabindex="0" role="button" aria-label="Open a long-label note">
        <div class="assignment-body">
          <div class="title">A long result card title that remains keyboard reachable on a narrow screen</div>
          <div class="meta">Course with a long label · Topic with a long label</div>
        </div>
      </div>`;
    const card = results.querySelector(".kb-result-card");
    card.focus();
    const style = getComputedStyle(card);
    return {
      active: document.activeElement === card,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
    };
  });
  assert.equal(focus.active, true, "long-label result card should receive keyboard focus");
  assert.equal(focus.outlineStyle, "solid", `focus ring should be deliberate, got ${focus.outlineStyle}`);
  assert.equal(focus.outlineWidth, "2px", `focus ring should be 2px, got ${focus.outlineWidth}`);
  assert.notEqual(focus.outlineColor, "rgb(0, 0, 0)", "focus ring should use the app accent, not a browser default");
  assert.equal(focus.outlineOffset, "2px", `focus ring should be offset, got ${focus.outlineOffset}`);
  console.log("✓ long-label result cards expose a deliberate keyboard focus ring");
} finally {
  await browser.close();
}
