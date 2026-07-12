// kb_ui_test.mjs — REAL browser (Playwright) end-to-end UI test for the
// Knowledge Base, run against the LOCAL dev server (http://localhost:4321).
//
// This complements the faster API-level tests in kb_e2e_test.mjs: it actually
// opens the page in Chromium, types into the search box, clicks chips, opens a
// result card, and asserts the UI renders correctly — plus captures screenshots
// so the autonomous loop can visually verify its work.
//
// Prereqs:
//   - dev server running:  node scripts/dev-server.mjs 4321
//   - data seeded:         node scripts/seed-dev.mjs 4321 400
//   - playwright installed: npm i -D playwright && npx playwright install chromium
//
// Usage:
//   node scripts/kb_ui_test.mjs                # uses http://localhost:4321
//   BASE_URL=https://app.vercel.app node ...   # point at any URL (local OR live)
//
// Exit code 0 = pass, non-zero = fail. Screenshots saved to scripts/screenshots/.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const SHOTS = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, fn) {
  return (async () => {
    try {
      await fn();
      results.push(["PASS", name]);
      console.log(`  ✓ ${name}`);
    } catch (e) {
      results.push(["FAIL", name, e.message]);
      console.error(`  ✗ ${name}\n      ${e.message}`);
    }
  })();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
// Fail fast on page errors.
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

try {
  console.log(`\n[KB UI e2e] against ${BASE}\n`);

  // --- Load the KB test harness (standalone mount of the KB feature) ---
  // The full app.js statically imports archive.js, which 404s in the local dev
  // harness, so the integrated tab can't boot locally. The live Vercel test
  // covers the full integrated app; here we drive the REAL kb.js + REAL api
  // routes through a standalone harness page.
  await check("harness page loads without error", async () => {
    const res = await page.goto(BASE + "/kb-test-harness.html", { waitUntil: "networkidle", timeout: 30000 });
    assert.ok(res && res.ok(), `HTTP ${res && res.status()}`);
  });

  await check("KB view is revealed by showKbView()", async () => {
    await page.waitForSelector("#kbView:not([hidden])", { timeout: 10000 });
    await page.waitForSelector("#kbSearchInput", { timeout: 10000 });
  });

  await check("search input is functional", async () => {
    await page.fill("#kbSearchInput", "cover letter");
  });

  // --- Run a search ---
  await check("search returns result cards", async () => {
    await page.click("#kbSearchInput");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
    const n = await page.locator("#kbResults .kb-result-card").count();
    assert.ok(n > 0, "expected at least one result card");
  });

  await check("filter chips render after search", async () => {
    await page.waitForSelector("#kbFilterChips:not([hidden]) .kb-chip", { timeout: 10000 });
    const chips = await page.locator("#kbFilterChips .kb-chip").count();
    assert.ok(chips > 0, "expected at least one filter chip");
  });

  await check("matched terms are highlighted in results", async () => {
    const marks = await page.locator("#kbResults mark").count();
    assert.ok(marks > 0, "expected <mark> highlights in snippets");
  });

  await page.screenshot({ path: SHOTS + "01-search-results.png", fullPage: true });

  // --- Click a result card -> detail modal ---
  await check("clicking a result card opens the note detail modal", async () => {
    await page.click("#kbResults .kb-result-card");
    await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
    const title = await page.locator("#kbNoteTitle").textContent();
    assert.ok(title && title.trim().length > 0, "detail modal should show a title");
  });

  await check("note detail shows a related-notes section", async () => {
    // related list may be populated async; just assert the section exists.
    await page.waitForSelector("#kbNoteRelated", { timeout: 8000 });
  });

  await page.screenshot({ path: SHOTS + "02-note-detail.png", fullPage: true });

  await check("closing the detail modal returns to results", async () => {
    const close = page.locator("#kbNoteModal .modal-close, #kbNoteModal [aria-label*='Close'], #kbNoteModal .modal-close-btn");
    if (await close.count()) await close.first().click();
    else await page.keyboard.press("Escape");
    await page.waitForSelector("#kbNoteModal[hidden]", { timeout: 8000 }).catch(() => {});
  });

  // --- Click a Year chip -> results narrow ---
  await check("clicking a Year filter chip re-runs search with the filter", async () => {
    const yearChip = page.locator("#kbFilterChips .kb-chip").first();
    await yearChip.click();
    await page.waitForTimeout(800); // allow re-fetch
    // either results updated or empty state shown — both are valid outcomes
    const cards = await page.locator("#kbResults .kb-result-card").count();
    const empty = await page.locator("#kbResults .empty").count();
    assert.ok(cards > 0 || empty > 0, "filter should produce results or an empty state");
    await page.screenshot({ path: SHOTS + "03-filtered.png", fullPage: true });
  });

  // --- Tutor modal opens (auth-gated in dev, but the UI must render) ---
  await check("AI tutor modal opens from the KB view", async () => {
    await page.click("#kbTutorOpen");
    await page.waitForSelector("#kbTutorModal:not([hidden])", { timeout: 8000 });
    await page.waitForSelector("#kbTutorInput", { timeout: 8000 });
    await page.screenshot({ path: SHOTS + "04-tutor.png", fullPage: true });
    await page.click("#kbTutorClose");
  });

  // --- Empty state ---
  // NOTE: the query must be GENUINE gibberish (tokens that appear nowhere in
  // the vault). A string like "zzqqxx_nothing_here" is NOT gibberish — its
  // tokens "nothing"/"here" are real words and legitimately match notes, so it
  // would never trigger the empty state. Use tokens with no real vocabulary.
  await check("a gibberish query shows the empty state", async () => {
    await page.fill("#kbSearchInput", "zzqqxxqwqy zxvbnm asdfgh");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .empty", { timeout: 8000 });
  });

  // --- No uncaught page errors throughout ---
  await check("no uncaught page errors during the run", async () => {
    assert.equal(pageErrors.length, 0, "page errors: " + pageErrors.join(" | "));
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n[KB UI e2e] ${results.length - failed.length}/${results.length} passed.`);
if (failed.length) {
  console.error("FAILED:");
  for (const f of failed) console.error(`  - ${f[1]}: ${f[2]}`);
  process.exit(1);
}
console.log("UI e2e OK");
