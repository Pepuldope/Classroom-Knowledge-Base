import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

try {
  const response = await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  assert.ok(response?.ok(), `index should load (HTTP ${response?.status()})`);

  const result = await page.evaluate(() => {
    const modal = document.querySelector("#settingsModal");
    const pane = document.querySelector('[data-pane="knowledge-base"]');
    if (!modal || !pane) throw new Error("Knowledge Base settings pane is missing");
    modal.hidden = false;
    pane.hidden = false;
    const select = pane.querySelector("select");
    if (!select) throw new Error("Knowledge Base settings select is missing");
    const style = getComputedStyle(select);
    return {
      className: select.className,
      borderRadius: style.borderRadius,
      padding: style.padding,
      backgroundColor: style.backgroundColor,
      transition: style.transition,
    };
  });

  const bookButton = await page.locator("#kbPrefExportBook");
  assert.equal(await bookButton.count(), 1, "Settings should offer a readable study-book export");
  assert.match(await bookButton.textContent(), /study book/i);

  assert.match(result.className, /settings-select/);
  assert.equal(result.borderRadius, "6px");
  assert.equal(result.padding, "7.2px 12px");
  assert.notEqual(result.backgroundColor, "rgba(0, 0, 0, 0)");
  assert.match(result.transition, /border-color/);
  assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
  console.log("✓ Knowledge Base Settings selects use the standard dropdown treatment");
} finally {
  await browser.close();
}
