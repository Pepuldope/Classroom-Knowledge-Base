// live_cross_view_related_retry_test.mjs — live-shell smoke for repeated related-note
// retry announcements in assignment-shaped cards on Archive and Planner.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const LIVE = (process.env.KB_LIVE_URL || "https://classroom-knowledge-google.vercel.app").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));

function fixtureScript(surfaceId) {
  return `
    (() => {
      const surface = document.getElementById(${JSON.stringify(surfaceId)});
      if (!surface) throw new Error("missing surface " + ${JSON.stringify(surfaceId)});
      const card = document.createElement("article");
      card.className = "assignment live-related-retry-fixture";
      card.tabIndex = 0;
      const body = document.createElement("div");
      body.className = "assignment-body";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = "Live related-note retry fixture";
      const preview = document.createElement("div");
      preview.className = "kb-related-preview is-error";
      preview.setAttribute("role", "status");
      preview.setAttribute("aria-live", "polite");
      let attempts = 1;
      const render = () => {
        const message = attempts === 1 ? "Related notes unavailable" : "Related notes still unavailable";
        preview.textContent = message + (attempts > 1 ? " after " + attempts + " attempts." : ".") + " ";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "kb-related-preview-retry";
        retry.setAttribute("aria-label", "Retry loading related notes");
        retry.textContent = "Retry related notes";
        retry.addEventListener("click", () => { attempts += 1; render(); card.focus(); });
        preview.appendChild(retry);
      };
      render();
      body.append(title, preview);
      card.appendChild(body);
      surface.appendChild(card);
      return true;
    })()
  `;
}

async function gotoLiveWithRetry() {
  let lastResponse = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResponse = await page.goto(LIVE, { waitUntil: "networkidle", timeout: 30000 });
    if (lastResponse?.ok()) return lastResponse;
    if (attempt < 3) await page.waitForTimeout(1000);
  }
  return lastResponse;
}

try {
  const response = await gotoLiveWithRetry();
  assert.ok(response?.ok(), `live site should load (HTTP ${response?.status()})`);
  await page.waitForSelector("#viewToggle:not([hidden])", { timeout: 15000 });
  for (const [view, surface] of [["archive", "archiveView"], ["planner", "plannerView"]]) {
    await page.locator(`.view-toggle-btn[data-view="${view}"]`).click();
    await page.waitForFunction((name) => {
      const node = document.getElementById(name);
      return node && !node.hidden;
    }, surface, { timeout: 10000 });

    await page.evaluate(fixtureScript(surface));
    const card = page.locator(".live-related-retry-fixture");
    const retry = card.locator(".kb-related-preview-retry");
    await retry.click();
    await retry.click();
    const result = await card.evaluate((node) => {
      const preview = node.querySelector(".kb-related-preview");
      const retryButton = preview?.querySelector(".kb-related-preview-retry");
      const box = retryButton?.getBoundingClientRect();
      return {
        announcement: preview?.textContent || "",
        role: preview?.getAttribute("role"),
        live: preview?.getAttribute("aria-live"),
        focused: document.activeElement === node,
        retryVisible: Boolean(box && box.width > 0 && box.height > 0),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.match(result.announcement, /still unavailable after 3 attempts/i, `${view}: repeated failure should be announced`);
    assert.equal(result.role, "status", `${view}: retry announcement should remain a status`);
    assert.equal(result.live, "polite", `${view}: retry announcement should remain polite`);
    assert.equal(result.focused, true, `${view}: retry should restore assignment-card focus`);
    assert.equal(result.retryVisible, true, `${view}: retry control should remain visible`);
    assert.equal(result.overflow, false, `${view}: retry fixture must not introduce mobile overflow`);
    await card.evaluate((node) => node.remove());
  }
  assert.deepEqual(pageErrors, [], `live page errors: ${pageErrors.join(" | ")}`);
  console.log(`✓ live Archive + Planner repeated related-preview retry smoke (${LIVE})`);
} finally {
  await browser.close();
}
