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

  // Regression: range output listeners must survive repeated changes in one
  // settings visit, not disappear after the first input event.
  await page.evaluate(() => document.querySelector("#settingsBtn")?.click());
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const modal = document.querySelector("#settingsModal");
    const pane = document.querySelector('[data-pane="knowledge-base"]');
    if (!modal || !pane) throw new Error("Knowledge Base settings pane is missing");
    modal.hidden = false;
    pane.hidden = false;
    const related = document.querySelector("#kbPrefRelatedCount");
    const output = document.querySelector("#kbPrefRelatedCountValue");
    if (!related || !output) throw new Error("Related-notes setting controls are missing");
    related.value = "4";
    related.dispatchEvent(new Event("input", { bubbles: true }));
    if (output.textContent !== "4") throw new Error(`first range update missing: ${output.textContent}`);
    related.value = "7";
    related.dispatchEvent(new Event("input", { bubbles: true }));
    if (output.textContent !== "7") throw new Error(`second range update missing: ${output.textContent}`);
  });

  const accountStatus = page.locator("#kbAccountStatus");
  assert.equal(await accountStatus.count(), 1, "Knowledge Base settings should show the local Classroom account status");
  assert.match(await accountStatus.textContent(), /not signed in|signed in as/i);
  assert.equal(await page.locator("#kbSwitchAccount").count(), 1, "Settings should offer account switching");
  assert.equal(await page.locator("#kbSignOut").count(), 1, "Settings should offer sign out");

  // Settings tabs must expose their selected pane to keyboard and assistive-technology users.
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll(".settings-tab")];
    const target = tabs.find((tab) => tab.dataset.tab === "knowledge-base");
    if (!target) throw new Error("Knowledge Base settings tab is missing");
    target.click();
  });
  const activeTab = page.locator('.settings-tab[data-tab="knowledge-base"]');
  assert.equal(await activeTab.getAttribute("aria-selected"), "true", "selected Settings tab should expose aria-selected=true");
  assert.equal(await page.locator('.settings-tab[data-tab="classes"]').getAttribute("aria-selected"), "false", "inactive Settings tab should expose aria-selected=false");
  assert.equal(await page.locator('[data-pane="knowledge-base"]').getAttribute("aria-labelledby"), await activeTab.getAttribute("id"), "selected pane should be labelled by its tab");

  const privacy = page.locator("#kbPrivacySummary");
  assert.equal(await privacy.count(), 1, "Knowledge Base settings should explain local storage and tutor sharing");
  assert.match(await privacy.textContent(), /stay in this browser/i);
  assert.match(await privacy.textContent(), /only the notes needed/i);
  assert.match(await privacy.textContent(), /read-only Google Classroom/i);

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
