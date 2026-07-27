// kb_copy_mobile_test.mjs — narrow mobile regression for KB copy confirmation.
// The fixture is intentionally long enough to exercise wrapping beside the
// action button without depending on a particular production corpus.
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
        <button class="secondary" type="button">Copy search context</button>
        <span class="kb-copy-status" role="status" aria-live="assertive">
          Could not copy search context. Check clipboard permissions and try again. This deliberately long fallback explains that clipboard permissions may be unavailable in a private browsing context and that the student can retry the copy action after granting access.
        </span>
      </div>`;
    const row = results.querySelector(".kb-result-actions");
    const status = results.querySelector(".kb-copy-status");
    const rowRect = row.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    const statusStyle = getComputedStyle(status);
    return {
      pageWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      rowWidth: rowRect.width,
      rowScrollWidth: row.scrollWidth,
      statusWidth: statusRect.width,
      statusScrollWidth: status.scrollWidth,
      statusHeight: statusRect.height,
      minWidth: statusStyle.minWidth,
      overflowWrap: statusStyle.overflowWrap,
    };
  });

  assert.ok(data.statusWidth > 0 && data.statusHeight > 0, "copy confirmation should have a visible box on mobile");
  assert.ok(data.pageScrollWidth <= data.pageWidth + 1, `page overflows horizontally: ${data.pageScrollWidth}px > ${data.pageWidth}px`);
  assert.ok(data.rowScrollWidth <= data.rowWidth + 1, `copy action row overflows: ${data.rowScrollWidth}px > ${data.rowWidth}px`);
  assert.ok(data.statusScrollWidth <= data.statusWidth + 1, `long copy status is clipped: ${data.statusScrollWidth}px > ${data.statusWidth}px`);
  assert.equal(data.minWidth, "0px", "copy status should be shrink-safe beside the action button");
  assert.equal(data.overflowWrap, "anywhere", "copy status should wrap long mobile messages");
  console.log(`✓ KB copy confirmation fits at 390px (${data.statusWidth}px status box)`);
} finally {
  await browser.close();
}
