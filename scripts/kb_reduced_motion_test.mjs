// kb_reduced_motion_test.mjs — related-preview loading respects reduced-motion preferences.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

async function inspect(reducedMotion) {
  const context = await browser.newContext({ reducedMotion });
  const page = await context.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${BASE}/kb-test-harness.html`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector("#kbView:not([hidden])", { timeout: 10000 });
    return await page.evaluate(() => {
      const kbMain = document.getElementById("kbMain");
      const results = document.getElementById("kbResults");
      if (!kbMain || !results) throw new Error("KB results surface is missing");
      kbMain.hidden = false;
      results.hidden = false;
      results.innerHTML = `
        <div class="assignment kb-result-card" role="button">
          <div class="assignment-body">
            <div class="summary archive-snippet">A result waiting for related notes</div>
            <div class="kb-related-preview is-loading">Loading related notes…</div>
          </div>
        </div>`;
      const preview = results.querySelector(".kb-related-preview");
      const style = getComputedStyle(preview, "::before");
      return { animationName: style.animationName, animationDuration: style.animationDuration };
    });
  } finally {
    await context.close();
  }
}

try {
  const normal = await inspect("no-preference");
  const reduced = await inspect("reduce");
  assert.notEqual(normal.animationName, "none", "normal related-preview loading should visibly animate");
  assert.ok(
    reduced.animationName === "none" || reduced.animationDuration === "0s",
    `reduced-motion loading treatment still animates (${reduced.animationName}, ${reduced.animationDuration})`,
  );
  console.log("✓ related-preview loading is static under reduced motion");
} finally {
  await browser.close();
}
