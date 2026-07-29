// cache_diagnostics_isolation_test.mjs — development-only related-cache diagnostics
// must stay out of the integrated/hosted student surface.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const LOCAL = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

async function assertProductionSurface(base, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  try {
    const response = await page.goto(`${base}/index.html`, { waitUntil: "networkidle", timeout: 45000 });
    assert.ok(response?.ok(), `${label}: index should load (HTTP ${response?.status()})`);
    await page.waitForSelector("#viewToggle:not([hidden])", { timeout: 15000 });
    const result = await page.evaluate(() => {
      const kb = document.getElementById("kbView");
      const body = document.body;
      return {
        devTools: document.querySelectorAll("[data-dev-only], #kbRelatedCacheStats, #kbRelatedCacheReset").length,
        diagnosticText: document.body.textContent?.match(/related-preview cache/i)?.[0] || null,
        kbPresent: Boolean(kb),
        pageFits: body.scrollWidth <= window.innerWidth + 1,
      };
    });
    assert.equal(result.devTools, 0, `${label}: development cache controls must not be in the integrated app`);
    assert.equal(result.diagnosticText, null, `${label}: cache diagnostics must not be visible to students`);
    assert.equal(result.kbPresent, true, `${label}: integrated KB surface should remain present`);
    assert.equal(result.pageFits, true, `${label}: hiding diagnostics must not introduce page overflow`);
    assert.deepEqual(pageErrors, [], `${label}: page errors: ${pageErrors.join(" | ")}`);
  } finally {
    await context.close();
  }
}

try {
  await assertProductionSurface(LOCAL, "local integrated surface");
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      const response = await page.goto(`${LOCAL}/kb-test-harness.html`, { waitUntil: "networkidle", timeout: 30000 });
      assert.ok(response?.ok(), `local harness should load (HTTP ${response?.status()})`);
      assert.equal(await page.locator("#kbRelatedCacheStats").count(), 1, "the local harness should retain its diagnostics summary");
      assert.equal(await page.locator("#kbRelatedCacheReset").count(), 1, "the local harness should retain its reset control");
    } finally {
      await context.close();
    }
  }
  console.log(`✓ related-cache diagnostics stay development-only (${LOCAL} integrated + harness)`);
} finally {
  await browser.close();
}
