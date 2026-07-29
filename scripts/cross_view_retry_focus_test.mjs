// cross_view_retry_focus_test.mjs — mobile related-preview retry stays keyboard-visible
// across Archive and Planner surfaces in both themes with reduced motion enabled.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

for (const theme of ["light", "dark"]) {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
    const surfaces = await page.evaluate((selectedTheme) => {
      document.documentElement.dataset.theme = selectedTheme;
      const archiveView = document.getElementById("archiveView");
      const targets = [document.getElementById("archiveMain"), document.getElementById("plannerView")];
      if (!archiveView || targets.some((target) => !target)) throw new Error("Archive/Planner surfaces are missing");
      archiveView.hidden = false;
      for (const target of targets) {
        target.hidden = false;
        const fixture = document.createElement("div");
        fixture.className = "assignment cross-view-retry-focus-fixture";
        fixture.innerHTML = '<div class="assignment-body"><div class="kb-related-preview is-error" role="status" aria-live="polite">Related notes unavailable <button class="kb-related-preview-retry" type="button" aria-label="Retry loading related notes">Retry</button></div></div>';
        target.append(fixture);
      }
      return targets.map((target) => {
        const retry = target.querySelector(".cross-view-retry-focus-fixture .kb-related-preview-retry");
        retry.focus();
        const style = getComputedStyle(retry);
        const preview = retry.closest(".kb-related-preview");
        const retryBox = retry.getBoundingClientRect();
        const previewBox = preview.getBoundingClientRect();
        return {
          active: document.activeElement === retry,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineOffset: style.outlineOffset,
          transform: style.transform,
          retryVisible: retryBox.width > 0 && retryBox.height > 0,
          previewFits: preview.scrollWidth <= preview.clientWidth + 2,
          surfaceFits: target.scrollWidth <= target.clientWidth + 2,
          previewVisible: previewBox.width > 0 && previewBox.height > 0,
        };
      });
    }, theme);
    for (const [surface, result] of surfaces.entries()) {
      assert.equal(result.active, true, `${theme}/${surface}: retry must receive keyboard focus`);
      assert.equal(result.outlineStyle, "solid", `${theme}/${surface}: retry focus ring must be deliberate`);
      assert.equal(result.outlineWidth, "2px", `${theme}/${surface}: retry focus ring must be 2px`);
      assert.equal(result.outlineOffset, "2px", `${theme}/${surface}: retry focus ring must be offset from the control`);
      assert.notEqual(result.transform, "none", `${theme}/${surface}: focused retry must visibly differentiate`);
      assert.ok(result.retryVisible && result.previewVisible, `${theme}/${surface}: retry/error state must be visible on mobile`);
      assert.ok(result.previewFits && result.surfaceFits, `${theme}/${surface}: retry/error state must not overflow on mobile`);
    }
  } finally {
    await context.close();
  }
}

await browser.close();
console.log(`✓ mobile related-preview retry focus ring is readable across Archive and Planner (${BASE})`);
