// Verify related-preview loading/error announcements remain readable and contained
// inside a real narrow KB result card, including the retry action.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

try {
  await page.goto(`${BASE}/kb-test-harness.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#kbView:not([hidden])");
  await page.evaluate(() => {
    const card = document.createElement("div");
    card.className = "kb-result-card";
    card.style.width = "100%";
    const preview = document.createElement("div");
    preview.className = "kb-related-preview is-error";
    preview.setAttribute("role", "status");
    preview.setAttribute("aria-live", "polite");
    preview.textContent = "Related notes still unavailable after 2 attempts. Retry loading related notes.";
    const retry = document.createElement("button");
    retry.className = "kb-related-preview-retry";
    retry.type = "button";
    retry.textContent = "Retry loading related notes";
    retry.setAttribute("aria-label", "Retry loading related notes");
    preview.appendChild(retry);
    card.appendChild(preview);
    document.body.appendChild(card);
  });

  const metrics = await page.locator(".kb-related-preview").evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    display: getComputedStyle(el).display,
    maxWidth: getComputedStyle(el).maxWidth,
    overflowWrap: getComputedStyle(el).overflowWrap,
    retryVisible: !!el.querySelector("button") && el.querySelector("button").getBoundingClientRect().width > 0,
  }));
  assert.equal(metrics.display, "flex", "mobile status must use a block flex layout");
  assert.equal(metrics.maxWidth, "100%", "status must not exceed its result card");
  assert.match(metrics.overflowWrap, /anywhere|break-word/, "long status text must wrap");
  assert.ok(metrics.width <= 390, `status width should fit the 390px viewport card, got ${metrics.width}`);
  assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `status overflows horizontally (${metrics.scrollWidth} > ${metrics.clientWidth})`);
  assert.equal(metrics.retryVisible, true, "retry action must remain visible and reachable");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ narrow KB related-preview status is readable and contained (${BASE})`);
} finally {
  await browser.close();
}
