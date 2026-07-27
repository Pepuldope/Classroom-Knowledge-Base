// kb_copy_history_mobile_test.mjs — narrow KB copy-history layout regression.
// Exercises the real stylesheet with both copy actions and long history metadata.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

try {
  await page.goto(`${BASE}/kb-test-harness.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#kbView:not([hidden])", { timeout: 10000 });
  const data = await page.evaluate(() => {
    const kbMain = document.getElementById("kbMain");
    const results = document.getElementById("kbResults");
    if (!kbMain || !results) throw new Error("KB results surface is missing");
    kbMain.hidden = false;
    results.hidden = false;
    results.innerHTML = `
      <div class="kb-result-actions">
        <button class="secondary kb-copy-context" type="button">Copy search context</button>
        <button class="secondary kb-copy-context" type="button">Copy again (12)</button>
        <span class="kb-copy-shortcut-hint">Shortcuts: / search · Esc clear</span>
        <span class="kb-copy-status" role="status">Copied 12 notes of titles and snippets.</span>
        <span class="kb-copy-history-entry" aria-label="Latest copied search context">Copied 12 results · an intentionally long search query with course and topic metadata that must wrap safely on a narrow screen</span>
        <button class="secondary kb-copy-history-dismiss" type="button">Dismiss history</button>
      </div>`;
    const row = results.querySelector(".kb-result-actions");
    const history = results.querySelector(".kb-copy-history-entry");
    const dismiss = results.querySelector(".kb-copy-history-dismiss");
    const historyRect = history.getBoundingClientRect();
    dismiss.focus();
    const dismissStyle = getComputedStyle(dismiss);
    const style = getComputedStyle(history);
    return {
      pageWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      rowWidth: row.getBoundingClientRect().width,
      rowScrollWidth: row.scrollWidth,
      historyWidth: historyRect.width,
      historyScrollWidth: history.scrollWidth,
      historyHeight: historyRect.height,
      dismissVisible: dismiss.getBoundingClientRect().width > 0,
      dismissFocused: document.activeElement === dismiss,
      dismissFocusRing: dismissStyle.outlineStyle === "solid" && dismissStyle.outlineWidth === "2px" && dismissStyle.outlineColor !== "rgb(16, 16, 16)",
      minWidth: style.minWidth,
      overflowWrap: style.overflowWrap,
    };
  });

  assert.ok(data.historyWidth > 0 && data.historyHeight > 0, "copy history should have a visible box on mobile");
  assert.equal(data.dismissVisible, true, "dismiss history control should remain visible beside the metadata");
  assert.equal(data.dismissFocused, true, "dismiss history control should be keyboard focusable");
  assert.equal(data.dismissFocusRing, true, "focused dismiss history control should show a visible focus ring");
  assert.ok(data.pageScrollWidth <= data.pageWidth + 1, `page overflows horizontally: ${data.pageScrollWidth}px > ${data.pageWidth}px`);
  assert.ok(data.rowScrollWidth <= data.rowWidth + 1, `copy history row overflows: ${data.rowScrollWidth}px > ${data.rowWidth}px`);
  assert.ok(data.historyScrollWidth <= data.historyWidth + 1, `long copy history is clipped: ${data.historyScrollWidth}px > ${data.historyWidth}px`);
  assert.equal(data.minWidth, "0px", "copy history should be shrink-safe on mobile");
  assert.equal(data.overflowWrap, "anywhere", "copy history should wrap long metadata");
  console.log(`✓ KB copy history fits at 390px (${data.historyWidth}px metadata box)`);
} finally {
  await browser.close();
}
