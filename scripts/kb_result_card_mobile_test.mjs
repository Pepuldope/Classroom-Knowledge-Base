// kb_result_card_mobile_test.mjs — long KB course/topic labels stay usable on phones.
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
      <div class="assignment kb-result-card" tabindex="0" role="button">
        <div class="assignment-body">
          <div class="title">A very long unbroken note title for responsive result-card coverage</div>
          <div class="meta">EngineeringAndLanguageIntegrationCourseWithAnExtremelyLongIdentifier · 2026 · AdvancedTopicWithAnUnusuallyLongLabel</div>
          <div class="summary archive-snippet">A realistic result snippet that should wrap without pushing the card wider than the phone viewport.</div>
        </div>
      </div>`;
    const card = results.querySelector(".kb-result-card");
    const body = results.querySelector(".assignment-body");
    const meta = results.querySelector(".meta");
    const rect = card.getBoundingClientRect();
    return {
      pageWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      cardWidth: rect.width,
      cardScrollWidth: card.scrollWidth,
      bodyScrollWidth: body.scrollWidth,
      bodyWidth: body.getBoundingClientRect().width,
      metaScrollWidth: meta.scrollWidth,
      metaWidth: meta.getBoundingClientRect().width,
      metaOverflowWrap: getComputedStyle(meta).overflowWrap,
    };
  });

  assert.ok(data.cardWidth > 0, "result card should have a visible box on mobile");
  assert.ok(data.pageScrollWidth <= data.pageWidth + 1, `page overflows: ${data.pageScrollWidth}px > ${data.pageWidth}px`);
  assert.ok(data.cardScrollWidth <= data.cardWidth + 1, `result card overflows: ${data.cardScrollWidth}px > ${data.cardWidth}px`);
  assert.ok(data.bodyScrollWidth <= data.bodyWidth + 1, `result body overflows: ${data.bodyScrollWidth}px > ${data.bodyWidth}px`);
  assert.ok(data.metaScrollWidth <= data.metaWidth + 1, `long course/topic metadata is clipped: ${data.metaScrollWidth}px > ${data.metaWidth}px`);
  assert.equal(data.metaOverflowWrap, "anywhere", "course/topic metadata should wrap long labels");
  console.log(`✓ KB result card fits at 390px (${data.cardWidth}px card)`);
} finally {
  await browser.close();
}
