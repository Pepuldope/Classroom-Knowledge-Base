// kb_related_retry_reduced_motion_test.mjs — keyboard retry restores the parent
// result-card focus after a related-preview failure under reduced motion.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const context = await browser.newContext({ reducedMotion: "reduce" });
const page = await context.newPage({ viewport: { width: 390, height: 844 } });

try {
  await page.route("**/api/kb-related**", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary failure" }) });
  });
  await page.goto(`${BASE}/kb-test-harness.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#kbView:not([hidden])", { timeout: 10000 });
  const input = page.locator("#kbSearchInput");
  await input.fill("cover letter");
  await page.waitForFunction(() => document.querySelectorAll("#kbResults .kb-result-card").length > 0, null, { timeout: 10000 });
  const card = page.locator("#kbResults .kb-result-card").first();
  const retry = card.locator(".kb-related-preview-retry");
  await retry.waitFor({ state: "visible", timeout: 10000 });
  const firstAnnouncement = await card.locator(".kb-related-preview").textContent();
  assert.match(firstAnnouncement || "", /Related notes unavailable/, "initial failure should announce that related notes are unavailable");
  await retry.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".kb-related-preview-retry")?.textContent === "Retry related notes", null, { timeout: 10000 });

  const result = await page.evaluate(() => {
    const parent = document.querySelector("#kbResults .kb-result-card");
    const preview = parent?.querySelector(".kb-related-preview");
    const retryButton = preview?.querySelector(".kb-related-preview-retry");
    const style = preview ? getComputedStyle(preview, "::before") : null;
    return {
      parentFocused: document.activeElement === parent,
      retryVisible: Boolean(retryButton && retryButton.getBoundingClientRect().width > 0),
      reducedMotionMarker: style?.animationName === "none" || style?.animationDuration === "0s",
      announcement: preview?.textContent || "",
    };
  });
  assert.equal(result.parentFocused, true, "failed related-preview retry should restore focus to the parent result card");
  assert.equal(result.retryVisible, true, "retry control should remain available after the repeated failure");
  assert.equal(result.reducedMotionMarker, true, "reduced-motion error marker should remain static");
  assert.match(result.announcement, /still unavailable after 2 attempts/, "repeated failure should retain its distinct announcement");
  console.log("✓ reduced-motion keyboard retry restores related-preview parent focus");
} finally {
  await context.close();
  await browser.close();
}
