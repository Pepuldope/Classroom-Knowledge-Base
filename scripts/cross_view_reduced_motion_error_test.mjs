// cross_view_reduced_motion_error_test.mjs — related-preview errors stay readable
// and announced when the shared Archive/Planner surfaces use reduced motion.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

function luminance(rgb) {
  const values = String(rgb).match(/[\d.]+/g);
  if (!values || values.length < 3) return null;
  return values.slice(0, 3).map(Number).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(foreground, background) {
  const fg = luminance(foreground);
  const bg = luminance(background);
  if (fg == null || bg == null) return null;
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

for (const theme of ["light", "dark"]) {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
    const result = await page.evaluate((selectedTheme) => {
      document.documentElement.dataset.theme = selectedTheme;
      const archiveView = document.getElementById("archiveView");
      const surfaces = [document.getElementById("plannerView"), document.getElementById("archiveMain")];
      if (!archiveView || surfaces.some((surface) => !surface)) throw new Error("Archive/Planner surfaces are missing");
      archiveView.hidden = false;
      for (const surface of surfaces) {
        surface.hidden = false;
        const fixture = document.createElement("div");
        fixture.className = "assignment cross-view-related-error-fixture";
        fixture.innerHTML = '<div class="assignment-body"><div class="kb-related-preview is-error" role="status" aria-live="polite">Related notes unavailable</div></div>';
        surface.append(fixture);
      }
      return surfaces.map((surface) => {
        const preview = surface.querySelector(".cross-view-related-error-fixture .kb-related-preview");
        const style = getComputedStyle(preview);
        let node = preview;
        let background = "rgba(0, 0, 0, 0)";
        while (node) {
          const candidate = getComputedStyle(node).backgroundColor;
          if (candidate !== "rgba(0, 0, 0, 0)" && candidate !== "transparent") {
            background = candidate;
            break;
          }
          node = node.parentElement;
        }
        const box = preview.getBoundingClientRect();
        return {
          text: preview.textContent,
          role: preview.getAttribute("role"),
          live: preview.getAttribute("aria-live"),
          color: style.color,
          background,
          animationName: getComputedStyle(preview, "::before").animationName,
          fits: preview.scrollWidth <= preview.clientWidth + 2,
          visible: box.width > 0 && box.height > 0,
        };
      });
    }, theme);
    for (const [surface, data] of result.entries()) {
      assert.equal(data.text, "Related notes unavailable", `${theme}/${surface}: error label missing`);
      assert.equal(data.role, "status", `${theme}/${surface}: error should be exposed as a status`);
      assert.equal(data.live, "polite", `${theme}/${surface}: error should be announced politely`);
      assert.equal(data.animationName, "none", `${theme}/${surface}: reduced-motion error marker should not animate`);
      assert.ok(data.visible, `${theme}/${surface}: error state should have a visible box`);
      assert.ok(data.fits, `${theme}/${surface}: error label should not clip at mobile width`);
      const ratio = contrast(data.color, data.background);
      assert.ok(ratio != null && ratio >= 4.5, `${theme}/${surface}: error contrast ${ratio?.toFixed(2) ?? "n/a"}:1`);
    }
  } finally {
    await context.close();
  }
}

await browser.close();
console.log(`✓ reduced-motion related-preview errors remain readable in Archive and Planner (${BASE})`);
