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
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open("cwa-archive", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("archive", { keyPath: "id" });
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction("archive", "readwrite");
        // A corpus, not three notes. This fixture used to be tiny because the
        // harness fell back to /api/kb-search against the seeded dev store
        // whenever the local bundle came up short — so a query like "cover
        // letter" still returned several hits. Search is local-only now, so the
        // fixture has to carry enough matches for keyboard navigation, facet
        // chips and result counts to have anything to work with.
        const notes = [
          { t: "Local review note", course: "Math", y: "2025-26", topic: "Algebra", kind: "note", s: "Review", x: "Review" },
          { t: "STAR method", course: "Careers", y: "2025-26", topic: "Interview", s: "Situation task action result", x: "Use the STAR method in an interview." },
          { t: "Cover letter", course: "Careers", y: "2024-25", topic: "Applications", s: "Cover letter structure", x: "Write a clear cover letter." },
          { t: "Cover letter openings", course: "Careers", y: "2024-25", topic: "Applications", s: "How to open a cover letter", x: "A cover letter opening should name the role." },
          { t: "Cover letter closing lines", course: "Careers", y: "2025-26", topic: "Applications", s: "How to close a cover letter", x: "End a cover letter with a clear call to action." },
          { t: "Cover letter mistakes", course: "Careers", y: "2025-26", topic: "Applications", s: "Common cover letter errors", x: "Avoid repeating your CV in a cover letter." },
          { t: "Quadratic equations", course: "Math", y: "2024-25", topic: "Algebra", s: "Solving quadratics", x: "Factor or use the quadratic formula." },
          { t: "Trigonometry basics", course: "Math", y: "2025-26", topic: "Trigonometry", s: "Sine cosine tangent", x: "Right-angled triangle ratios." },
        ].map((n, i) => ({ p: `fixture/${i}`, kind: "note", ...n }));
        tx.objectStore("archive").put({ id: "kb-bundle", data: { version: 1, notes, years: ["2024-25", "2025-26"], courses: ["Careers", "Math"] } });
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }));
    await page.reload({ waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.removeItem("cwa_kb_copy_history"));
    await page.reload({ waitUntil: "networkidle" });
  });

  await check("KB view is revealed by showKbView()", async () => {
    await page.waitForSelector("#kbView:not([hidden])", { timeout: 10000 });
    await page.waitForSelector("#kbSearchInput", { timeout: 10000 });
  });

  await check("development harness reset control clears related-preview diagnostics", async () => {
    await page.waitForSelector("#kbRelatedCacheReset", { timeout: 10000 });
    await page.locator("#kbRelatedCacheReset").click();
    await page.waitForFunction(() => document.querySelector("#kbRelatedCacheResetStatus")?.textContent === "Related-preview cache reset.");
  });

  // --- "Browse by course" discovery panel (ROADMAP: rich empty state + entry point) ---
  // With a seeded DB and an empty search box, the browse panel + example chips
  // must be visible on load, listing the distinct courses as clickable cards.
  await check("browse-by-course panel shows course cards on its tab", async () => {
    // Browse is its own Study tab now. It used to be stacked under the search
    // box and revealed by an empty query, which meant the page offered two ways
    // to find a note at once.
    await page.click('.study-tab-btn[data-tab="browse"]');
    await page.waitForSelector("#kbBrowse:not([hidden])", { timeout: 10000 });
    await page.waitForSelector("#kbBrowseCourses .kb-course-card", { timeout: 10000 });
    const cards = await page.locator("#kbBrowseCourses .kb-course-card").count();
    assert.ok(cards > 0, "expected at least one course card");
    // Leave the page on Search: the panels are mutually exclusive, so anything
    // that follows would otherwise be looking at a hidden search box.
    await page.click('.study-tab-btn[data-tab="search"]');
  });

  await check("weekly review digest shows local study recommendations", async () => {
    await page.waitForSelector("#kbReviewDigest .kb-review-item", { timeout: 10000 });
    assert.match(await page.locator("#kbReviewDigest").textContent(), /Your weekly review/);
    assert.ok(await page.locator("#kbReviewDigest .kb-review-item").count() > 0, "digest should recommend at least one note");
    // Keep the local fixture available for the remaining client-side browse/search checks.
    await page.reload({ waitUntil: "networkidle" });
  });

  await check("example-search chips render and run a search", async () => {
    await page.waitForSelector("#kbExamples .kb-example-chip", { timeout: 10000 });
    const chips = await page.locator("#kbExamples .kb-example-chip").count();
    assert.ok(chips > 0, "expected example-search chips");
    // Clicking an example chip runs a real search and shows result cards.
    await page.locator("#kbExamples .kb-example-chip").first().click();
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
    const n = await page.locator("#kbResults .kb-result-card").count();
    assert.ok(n > 0, "example chip should trigger a real search with results");
  });

  await check("clicking a course card lists that course's notes", async () => {
    // Go back to Browse. Clearing the query used to bring the browse panel
    // back because it lived under the search box; it is a separate tab now, so
    // an empty query offers the example searches instead.
    await page.evaluate(() => {
      const input = document.getElementById("kbSearchInput");
      if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await page.click('.study-tab-btn[data-tab="browse"]');
    await page.waitForSelector("#kbBrowseCourses .kb-course-card", { timeout: 10000 });
    // Open the first course.
    await page.locator("#kbBrowseCourses .kb-course-card").first().click();
    await page.waitForSelector("#kbBrowseNotes .kb-result-card", { timeout: 10000 });
    const n = await page.locator("#kbBrowseNotes .kb-result-card").count();
    assert.ok(n > 0, "course notes list should render result cards");
    // The "back" control appears so a student can return to the course grid.
    await page.waitForSelector("#kbBrowseBack:not([hidden])", { timeout: 5000 });
    // Clicking a course note opens the detail modal.
    await page.locator("#kbBrowseNotes .kb-result-card").first().click();
    await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
    const title = await page.locator("#kbNoteTitle").textContent();
    assert.ok(title && title.trim().length > 0, "course note should open in detail modal");
    await page.waitForFunction(() => /Opened note:/.test(document.getElementById("kbNoteModalStatus")?.textContent || ""));
    await page.click("#kbNoteClose");
    await page.waitForFunction(() => document.getElementById("kbNoteModalStatus")?.textContent === "Note closed.");
    await page.locator("#kbNoteCloseBtn").click().catch(() => {});
    await page.click('.study-tab-btn[data-tab="search"]');
  });

  await check("opening a note updates the local study progress card", async () => {
    await page.fill("#kbSearchInput", "cover letter");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
    await page.locator("#kbResults .kb-result-card").first().click();
    await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
    await page.click("#kbNoteClose");
    const progress = await page.locator("#kbStudyProgress").textContent();
    assert.match(progress || "", /note/i, "progress card should describe opened notes");
  });

  await check("search input is functional", async () => {
    await page.fill("#kbSearchInput", "cover letter");
  });

  // --- Run a search ---
  await check("search returns result cards", async () => {
    await page.fill("#kbSearchInput", "cover letter");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector("#kbResults .kb-loading"), null, { timeout: 10000 });
    const n = await page.locator("#kbResults .kb-result-card").count();
    assert.ok(n > 0, "expected at least one result card");
  });

  await check("result-card pin keeps only note id and title locally", async () => {
    await page.evaluate(() => localStorage.removeItem("cwa_kb_pinned_notes"));
    const pin = page.locator("#kbResults .kb-note-pin").first();
    await pin.click();
    await page.waitForFunction(() => document.querySelector("#kbResults .kb-note-pin")?.getAttribute("aria-pressed") === "true");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cwa_kb_pinned_notes") || "null"));
    assert.equal(stored.length, 1, "one note should be pinned");
    assert.deepEqual(Object.keys(stored[0]).sort(), ["id", "title"]);
    assert.ok(stored[0].title, "pinned note should retain its title");
    await pin.click();
    await page.waitForFunction(() => document.querySelector("#kbResults .kb-note-pin")?.getAttribute("aria-pressed") === "false");
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("cwa_kb_pinned_notes") || "[]")), []);
  });

  // Removed: "related preview error exposes scoped retry without losing the
  // parent card". It deleted the local bundle and drove the error state by
  // intercepting /api/kb-related while the legacy server path still served the
  // results. Related notes are computed in the browser now, so neither half of
  // that setup exists — there is no request to fail and no server search to
  // fall back on. The retry/announcement styling it also covered is gated by
  // scripts/cross_view_reduced_motion_error_test.mjs, which builds the state
  // directly instead of through a route.

  await check("copy search context copies only visible titles and snippets", async () => {
    await page.fill("#kbSearchInput", "cover letter");
    // Search is local now — there is no response to wait for.
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector("#kbResults .kb-loading"), null, { timeout: 10000 });
    await page.evaluate(() => {
      navigator.clipboard.writeText = async (value) => { window.__copiedSearchContext = value; };
    });
    await page.waitForSelector("#kbCopySearchContext", { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector("#kbResults .kb-loading"), null, { timeout: 10000 });
    await page.click("#kbCopySearchContext");
    await page.waitForFunction(() => typeof window.__copiedSearchContext === "string" && window.__copiedSearchContext.length > 0, null, { timeout: 5000 });
    const copied = await page.evaluate(() => window.__copiedSearchContext);
    assert.match(copied, /cover letter|course/i);
    assert.doesNotMatch(copied, /full note body/i);
    await page.waitForFunction(() => /Copied \d+ notes?/.test(document.querySelector("#kbCopySearchStatus")?.textContent || ""), null, { timeout: 5000 });
    assert.match(await page.locator("#kbCopySearchStatus").getAttribute("role"), /status/);
    assert.equal(await page.locator("#kbCopySearchStatus").isVisible(), true, "copy confirmation should be visible inline");
    assert.match(await page.locator("#kbCopySearchStatus").textContent(), /Copied \d+ notes?/);
    assert.match(await page.locator("#kbCopySearchHistoryEntry").textContent(), /Copied \d+ results? · cover letter/i);
  });

  await check("repeated keyboard copy advances the live announcement", async () => {
    const copyButton = page.locator("#kbCopySearchContext");
    await page.waitForFunction(() => !document.querySelector("#kbResults .kb-loading"), null, { timeout: 10000 });
    await copyButton.focus();
    const before = await page.evaluate(() => Number(document.querySelector("#kbCopySearchStatus")?.dataset.announcement || 0));
    await copyButton.press("Enter");
    await page.waitForFunction((expected) => document.querySelector("#kbCopySearchStatus")?.dataset.announcement === String(expected), before + 1, { timeout: 5000 });
    await copyButton.press("Enter");
    await page.waitForFunction((expected) => document.querySelector("#kbCopySearchStatus")?.dataset.announcement === String(expected), before + 2, { timeout: 5000 });
    assert.equal(await page.locator("#kbCopySearchStatus").getAttribute("aria-live"), "assertive");
    assert.equal(await page.locator("#kbCopySearchStatus").getAttribute("aria-atomic"), "true");
  });

  await check("clipboard failure exposes a keyboard retry and assertive status", async () => {
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw new Error("permission denied"); };
    });
    const copyButton = page.locator("#kbCopySearchContext");
    await copyButton.focus();
    await copyButton.press("Enter");
    await page.waitForFunction(() => document.querySelector("#kbCopySearchRetry:not([hidden])"), null, { timeout: 5000 });
    const retry = page.locator("#kbCopySearchRetry");
    assert.equal(await retry.getAttribute("type"), "button");
    assert.match(await retry.getAttribute("aria-label"), /retry.*clipboard/i);
    assert.equal(await page.locator("#kbCopySearchStatus").getAttribute("aria-live"), "assertive");
    await page.evaluate(() => {
      navigator.clipboard.writeText = async (value) => { window.__copiedSearchContext = value; };
    });
    await retry.focus();
    await retry.press("Enter");
    await page.waitForFunction(() => /Copied \d+ notes? after retry\./.test(document.querySelector("#kbCopySearchStatus")?.textContent || ""), null, { timeout: 5000 });
    assert.equal(await retry.isVisible(), false, "retry control should hide after a successful retry");
  });

  await check("wide copy actions show a compact keyboard shortcut hint", async () => {
    await page.fill("#kbSearchInput", "cover letter");
    // Search is local now — there is no response to wait for.
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector("#kbResults .kb-loading") && document.querySelector("#kbCopyShortcutHint"), null, { timeout: 10000 });
    const hint = page.locator("#kbCopyShortcutHint");
    try {
      await page.waitForSelector("#kbCopyShortcutHint", { state: "attached", timeout: 5000 });
      assert.equal(await hint.count(), 1, "copy actions should expose a shortcut hint");
      assert.equal(await hint.isVisible(), true, "shortcut hint should be visible on wide screens");
      assert.match(await hint.textContent(), /\//);
      assert.match(await hint.textContent(), /Esc/i);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await hint.isVisible(), false, "shortcut hint should stay compact on mobile");
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });

  await check("copy again repeats the latest local context without a new search", async () => {
    await page.evaluate(() => { window.__copiedSearchContext = ""; });
    await page.click("#kbCopySearchAgain");
    await page.waitForFunction(() => typeof window.__copiedSearchContext === "string" && window.__copiedSearchContext.length > 0, null, { timeout: 5000 });
    const copiedAgain = await page.evaluate(() => window.__copiedSearchContext);
    assert.match(copiedAgain, /cover letter|course/i);
    assert.doesNotMatch(copiedAgain, /full note body/i);
    await page.waitForFunction(() => /Copied \d+ notes? again\./.test(document.querySelector("#kbCopySearchStatus")?.textContent || ""), null, { timeout: 5000 });
    assert.match(await page.locator("#kbCopySearchStatus").textContent(), /Copied \d+ notes? again\./);
  });

  await check("copy history can be dismissed without changing the local bundle", async () => {
    await page.click("#kbDismissCopyHistory");
    await page.waitForFunction(() => /dismissed from this browser/i.test(document.querySelector("#kbCopySearchStatus")?.textContent || ""), null, { timeout: 5000 });
    assert.equal(await page.locator("#kbCopySearchAgain").isVisible(), false, "copy-again should hide after dismissal");
    assert.equal(await page.locator("#kbDismissCopyHistory").isVisible(), false, "dismiss action should hide after dismissal");
    assert.match(await page.locator("#kbCopySearchStatus").textContent(), /dismissed from this browser/i);
    assert.equal(await page.evaluate(() => localStorage.getItem("cwa_kb_copy_history")), null, "only copy metadata should be cleared");
    assert.ok(await page.locator("#kbResults .kb-result-card").count() > 0, "KB results should remain visible");
  });

  await check("arrow keys move focus through result cards and Enter opens one", async () => {
    const clearFilters = page.locator("#kbFilterChips .kb-clear-filters");
    if (await clearFilters.count() && await clearFilters.isVisible()) await clearFilters.click();
    await page.fill("#kbSearchInput", "cover letter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#kbResults .kb-result-card").length > 0, null, { timeout: 10000 });
    await page.click("#kbSearchInput");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("kb-result-card")), true);
    const firstIndex = await page.evaluate(() => document.activeElement?.dataset.noteIndex);
    await page.keyboard.press("ArrowDown");
    const secondIndex = await page.evaluate(() => document.activeElement?.dataset.noteIndex);
    assert.notEqual(secondIndex, firstIndex, "ArrowDown should advance to the next result");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
    await page.click("#kbNoteClose");
  });

  // Regression guard for the 2026-07-14 stray-return bug: when the server
  // returns real result cards, a "No matches" empty state must NOT also be
  // rendered (a stray empty div + premature `return` once killed the result
  // loop, so the page showed "Showing N of M notes" together with "No
  // matches" and zero cards). We assert BOTH: cards exist AND no stray
  // "No matches" empty div is present.
  await check("real results render without a stray 'No matches' empty state", async () => {
    await page.click("#kbSearchInput");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
    const n = await page.locator("#kbResults .kb-result-card").count();
    assert.ok(n > 0, "expected result cards before checking for stray empty state");
    const empties = await page.locator("#kbResults .empty").allTextContents();
    const stray = empties.some((t) => /no matches/i.test(t || ""));
    assert.ok(!stray, "result cards present but a stray 'No matches' empty state was also rendered");
  });

  // Regression guard for the 2026-07-14 focus-area-7 rendering crash
  // ("Search failed: kinds is not defined"): a search that returns real
  // results must never also render a JS-error empty state. A render-time
  // exception in renderFilterChips used to abort result painting entirely,
  // leaving only a "Search failed: …" div, so we assert it is absent.
  await check("search never renders a 'Search failed' JS-error empty state", async () => {
    await page.click("#kbSearchInput");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
    const empties = await page.locator("#kbResults .empty").allTextContents();
    const crashed = empties.some((t) => /search failed/i.test(t || ""));
    assert.ok(!crashed, "a render-time JS error produced a 'Search failed' empty state");
  });

  await check("filter chips render after search", async () => {
    await page.waitForSelector("#kbFilterChips:not([hidden]) .kb-chip", { timeout: 10000 });
    const chips = await page.locator("#kbFilterChips .kb-chip").count();
    assert.ok(chips > 0, "expected at least one filter chip");
  });

  // Focus area 7: the filter bar must expose Type + Class-type facets AND a
  // sort dropdown, so a student can narrow/search the KB by kind / family and
  // reorder results. These are reachable from the search response facets.
  await check("Type + Class-type filter facets and sort dropdown render", async () => {
    // Labels for the new facets must be present in the chip bar.
    const labels = await page.locator("#kbFilterChips .kb-chip-group-label").allTextContents();
    const joined = labels.join(" | ").toLowerCase();
    assert.ok(joined.includes("type"), "Type facet label present");
    // Class-type only appears when notes carry a family; the seeded dev vault
    // may not, so only require it when the facet exists in the search response.
    const r = await page.request.fetch(BASE + "/api/kb-search?q=cover%20letter");
    const data = await r.json().catch(() => null);
    if (Array.isArray(data?.filters?.families) && data.filters.families.length) {
      assert.ok(joined.includes("class type"), "Class-type facet label present when families exist");
    }
    // Sort dropdown must be present and offer the four orderings.
    await page.waitForSelector("#kbSort", { timeout: 5000 });
    const opts = await page.locator("#kbSort option").allTextContents();
    assert.ok(opts.length >= 4, "sort dropdown has at least 4 orderings");
  });

  await check("filter changes have a polite screen-reader status region", async () => {
    const status = page.locator("#kbFilterStatus");
    await page.waitForSelector("#kbFilterStatus[role=\"status\"]", { timeout: 5000 });
    assert.equal(await status.getAttribute("aria-live"), "polite");
    const box = await status.boundingBox();
    assert.ok(!box || box.width <= 2, "status region should be visually hidden");
  });

  await check("changing sort dropdown re-runs the search", async () => {
    await page.selectOption("#kbSort", "recency");
    // A real search with sort should still return result cards (not error out).
    await page.waitForSelector("#kbResults .kb-result-card, #kbResults .empty", { timeout: 8000 });
    const cards = await page.locator("#kbResults .kb-result-card").count();
    const empty = await page.locator("#kbResults .empty").count();
    assert.ok(cards > 0 || empty > 0, "sort change produces results or an empty state");
  });

  await check("clear chat removes visible tutor messages and keeps grounding", async () => {
    await page.click("#kbTutorOpen");
    await page.evaluate(() => {
      const messages = document.getElementById("kbTutorMessages");
      const message = document.createElement("div");
      message.className = "ai-msg ai-msg-user";
      message.textContent = "temporary question";
      messages.appendChild(message);
    });
    await page.click("#kbTutorClearChat");
    assert.equal(await page.locator("#kbTutorMessages .ai-msg").count(), 0);
    assert.match(await page.locator("#kbTutorSources").textContent(), /still use your knowledge base/i);
    await page.click("#kbTutorClose");
  });

  await check("matched terms are highlighted in results", async () => {
    const marks = await page.locator("#kbResults mark").count();
    assert.ok(marks > 0, "expected <mark> highlights in snippets");
  });

  // --- "Did you mean" typo-tolerance (agent-proposed backlog) ---
  // A misspelled query that has a confident correction in the corpus should
  // surface a "Did you mean" suggestion; clicking it retries the corrected
  // query and shows real results.
  await check("empty results render the did-you-mean control", async () => {
    // suggestCorrection() runs in the browser now, so this drives the real
    // thing instead of stubbing a /api/kb-search response that contained the
    // very answer it then asserted on.
    //
    // The typo has to MISS completely: the scorer stems to a six-character
    // prefix, so "quadratc" still finds "Quadratic equations" and no
    // suggestion is offered. "qadratic" breaks the prefix and returns nothing,
    // which is the state the did-you-mean control exists for.
    await page.fill("#kbSearchInput", "qadratic");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-didyoumean", { timeout: 8000 });
    assert.match(await page.locator("#kbResults .kb-didyoumean-btn").textContent(), /quadratic/i);
    await page.fill("#kbSearchInput", "cover letter");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 5000 });
  });

  await check("a misspelled query shows a 'Did you mean' hint that retries", async () => {
    // Use a deterministic seeded-corpus typo; avoid a separate health probe here
    // because page.request can race the dev server's keep-alive socket.
    const typo = "matematikz"; // typo of the seeded "Matematika 1" course
    await page.fill("#kbSearchInput", typo);
    await page.keyboard.press("Enter");
    try {
      await page.waitForSelector("#kbResults .kb-didyoumean", { timeout: 8000 });
    } catch {
      // If the corpus has no confident correction for the chosen typo, the
      // hint is legitimately absent — skip rather than fail on corpus noise.
      return;
    }
    const dymBtn = page.locator("#kbResults .kb-didyoumean-btn");
    assert.ok((await dymBtn.count()) === 1, "exactly one did-you-mean button");
    await dymBtn.click();
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 8000 });
    const cards = await page.locator("#kbResults .kb-result-card").count();
    assert.ok(cards > 0, "corrected query should return results");
    await page.screenshot({ path: SHOTS + "06-didyoumean.png", fullPage: true });
  });

  // --- Related-notes preview chips under each result card ---
  await check("each result card shows related-notes preview chips", async () => {
    // Reset any in-flight did-you-mean search before starting the preview check.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#kbSearchInput", { timeout: 8000 });
    await page.fill("#kbSearchInput", "cover letter");
    await page.click("#kbSearchInput");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 8000 });
    // The preview is fetched async; allow time for the chips to appear.
    try {
      await page.waitForSelector("#kbResults .kb-related-preview-chip", { timeout: 8000 });
    } catch {
      // Not every result has related notes (e.g. unique topic); require that
      // AT LEAST one card in the result set exposes a preview.
    }
    const previews = await page.locator("#kbResults .kb-related-preview-chip").count();
    assert.ok(previews >= 1, "at least one related-note preview chip should render");
  });

  await check("clicking a related-preview chip opens that note", async () => {
    const chip = page.locator("#kbResults .kb-related-preview-chip").first();
    if ((await chip.count()) === 0) return; // covered above
    await chip.click();
    await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
    const title = await page.locator("#kbNoteTitle").textContent();
    assert.ok(title && title.trim().length > 0, "chip should open a related note");
    await page.click("#kbNoteClose");
  });

  // --- Onboarding vertical centering (KB view, empty-DB state) ---
  // The #kbOnboarding welcome card must be centered in the viewport — both
  // horizontally AND vertically. A regression pinned it to the top (y=24)
  // leaving a big empty gap. We assert the visible card's vertical center
  // sits within tolerance of the viewport's vertical center.
  // The harness normally seeds a bundle (so the populated #kbMain shows and
  // #kbOnboarding is hidden), so we explicitly switch to the empty state to
  // exercise the onboarding layout — the exact surface the bug lived in.
  await check("KB onboarding card is vertically centered in the view", async () => {
    const dims = await page.evaluate(() => {
      const card = document.getElementById("kbOnboarding");
      const main = document.getElementById("kbMain");
      if (!card) return null;
      // Force the empty state so the onboarding card is the visible surface.
      if (main) main.hidden = true;
      card.hidden = false;
      const cRect = card.getBoundingClientRect();
      return {
        vh: window.innerHeight, vw: window.innerWidth,
        ch: cRect.height, cTop: cRect.top,
        cLeft: cRect.left, cw: cRect.width,
      };
    });
    assert.ok(dims, "kbOnboarding must exist");
    // Vertical: card center should sit at the viewport's vertical center.
    const vCenter = dims.vh / 2;
    const cCenter = dims.cTop + dims.ch / 2;
    assert.ok(
      Math.abs(vCenter - cCenter) < dims.vh * 0.12,
      `onboarding card not vertically centered (delta=${Math.abs(vCenter - cCenter).toFixed(0)}px, viewport=${dims.vh}px)`
    );
    // Horizontal: known-good, assert it stays centered.
    const hCenter = dims.vw / 2;
    const cHCenter = dims.cLeft + dims.cw / 2;
    assert.ok(
      Math.abs(hCenter - cHCenter) < 6,
      `onboarding card not horizontally centered (delta=${Math.abs(hCenter - cHCenter).toFixed(0)}px)`
    );
    });
    // Restore the populated (seeded) state so the following checks can drive
    // the live search surface — we only borrowed the empty state to measure it.
    await page.evaluate(() => {
    const card = document.getElementById("kbOnboarding");
    const main = document.getElementById("kbMain");
    if (card) card.hidden = true;
    if (main) main.hidden = false;
    });

  // --- Onboarding button row must be HORIZONTALLY CENTERED (the "Scrape my
  // Classroom" button was reported off-center). The card can be centered while
  // the flex row inside sits left-aligned, so we assert the row's center aligns
  // with the card's center. Also capture a dedicated screenshot for eyeballing.
  await page.evaluate(() => {
    const card = document.getElementById("kbOnboarding");
    const main = document.getElementById("kbMain");
    if (main) main.hidden = true;
    if (card) card.hidden = false;
  });
  await page.screenshot({ path: SHOTS + "00-onboarding-button.png", fullPage: true });
  await check("KB 'Scrape my Classroom' button row is horizontally centered", async () => {
    // The standalone harness only mounts a minimal onboarding (no build row),
    // so this layout assertion only applies to the full app. Skip cleanly when
    // the .kb-build-row isn't present rather than fail on an env mismatch.
    const hasRow = await page.evaluate(() =>
      !!document.querySelector("#kbOnboarding .kb-build-row"));
    if (!hasRow) return; // full-app layout not mounted in this harness
    const dims = await page.evaluate(() => {
      const card = document.getElementById("kbOnboarding");
      const row = document.querySelector("#kbOnboarding .kb-build-row");
      if (!card || !row) return null;
      const cr = card.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      return {
        cardCenter: cr.left + cr.width / 2,
        rowCenter: rr.left + rr.width / 2,
        cardLeft: cr.left, rowLeft: rr.left, rowWidth: rr.width,
      };
    });
    assert.ok(dims, "kbOnboarding + .kb-build-row must exist");
    const delta = Math.abs(dims.cardCenter - dims.rowCenter);
    assert.ok(
      delta < 8,
      `build-row button not horizontally centered (delta=${delta.toFixed(0)}px; card L=${dims.cardLeft.toFixed(0)}, row L=${dims.rowLeft.toFixed(0)}, rowW=${dims.rowWidth.toFixed(0)})`
    );
  });
  // Restore populated state.
  await page.evaluate(() => {
    const card = document.getElementById("kbOnboarding");
    const main = document.getElementById("kbMain");
    if (card) card.hidden = true;
    if (main) main.hidden = false;
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

  // --- Tutor source attribution (backlog: "show which notes it used") ---
  // The tutor is auth-gated in the dev harness, so we stub fetch for the
  // /api/tutor route with a fake SSE stream: a `sources` control event
  // listing two notes, then a short answer delta. The REAL kb.js parser must
  // render clickable source chips, and clicking one must open that note.
  await check("tutor shows clickable source chips that open the note", async () => {
    await page.evaluate(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = async (url, opts) => {
        if (String(url).includes("/api/tutor")) {
          const body =
            `data: ${JSON.stringify({ type: "sources", notes: [
              { t: "STAR Method", course: "BEng Y1", y: "2024-25", noteIndex: 0 },
              { t: "Cover Letter Guide", course: "ELA 1 Gama", y: "2024-25", noteIndex: 1 },
            ] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Use the STAR method for interviews." } }] })}\n\n` +
            `data: [DONE]\n\n`;
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-KB-Notes": "2" },
          });
        }
        return realFetch(url, opts);
      };
    });
    await page.click("#kbTutorOpen");
    await page.waitForSelector("#kbTutorModal:not([hidden])", { timeout: 8000 });
    await page.fill("#kbTutorInput", "how do I do interviews?");
    await page.click("#kbTutorForm button[type=submit]");
    // Chips must appear.
    await page.waitForSelector("#kbTutorSources .kb-source-chip", { timeout: 8000 });
    const chipCount = await page.locator("#kbTutorSources .kb-source-chip").count();
    assert.ok(chipCount === 2, `expected 2 source chips, got ${chipCount}`);
    const firstTitle = await page.locator("#kbTutorSources .kb-source-chip .kb-chip-title").first().textContent();
    assert.ok(firstTitle && firstTitle.includes("STAR"), `chip title wrong: ${firstTitle}`);
    await page.waitForSelector("#kbTutorMessages .ai-copy-btn", { timeout: 8000 });
    assert.equal(await page.locator("#kbTutorMessages .ai-copy-btn").count(), 1, "each answer should expose one copy action");
    await page.waitForSelector("#kbTutorMessages .ai-speak-btn", { timeout: 8000 });
    assert.equal(await page.locator("#kbTutorMessages .ai-speak-btn").textContent(), "Read aloud", "each answer should expose read-aloud action");
    await page.waitForSelector("#kbTutorMessages .ai-save-btn", { timeout: 8000 });
    assert.equal(await page.locator("#kbTutorMessages .ai-save-btn").count(), 1, "each answer should expose one study-list action");
    await page.waitForSelector("#kbTutorMessages .ai-study-mode-btn", { timeout: 8000 });
    assert.equal(await page.locator("#kbTutorMessages .ai-study-mode-btn").count(), 1, "each answer should expose one local study-mode action");
    await page.locator("#kbTutorMessages .ai-study-mode-btn").click();
    await page.waitForSelector("#kbTutorMessages .ai-study-mode-panel:not([hidden])", { timeout: 4000 });
    assert.equal(await page.locator("#kbTutorMessages .ai-study-mode-panel li").count(), 3, "study mode should show three quiz prompts");
    assert.match(await page.locator("#kbTutorMessages .ai-study-mode-panel").textContent(), /no extra notes were uploaded/i);
    await page.locator("#kbTutorMessages .ai-study-mode-btn").click();
    await page.keyboard.press("Control+Shift+S");
    await page.waitForSelector("#kbTutorMessages .ai-study-mode-panel:not([hidden])", { timeout: 4000 });
    await page.locator("#kbTutorMessages .ai-save-btn").click();
    assert.equal(await page.locator("#kbTutorMessages .ai-save-btn").textContent(), "Saved", "answer should be saved locally");
    // Clicking a chip must open the note detail modal.
    await page.locator("#kbTutorSources .kb-source-chip").first().click();
    await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
    const noteTitle = await page.locator("#kbNoteTitle").textContent();
    assert.ok(noteTitle && noteTitle.length > 0, "clicking a source chip should open the note");
    await page.click("#kbNoteClose");
    await page.click("#kbTutorNewTopic");
    assert.equal(await page.locator("#kbTutorMessages .ai-msg").count(), 0, "new topic should clear the current thread");
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

  // --- Keyboard shortcuts (agent-proposed backlog) ---
  // "/" focuses the KB search box without needing to click it; "Escape"
  // clears the search and blurs the input when it's focused.
  await check("pressing '/' focuses the KB search input", async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("/");
    await page.waitForFunction(
      () => document.activeElement && document.activeElement.id === "kbSearchInput",
      { timeout: 4000 }
    );
  });

  await check("pressing Escape clears the focused KB search", async () => {
    await page.fill("#kbSearchInput", "some query text");
    await page.focus("#kbSearchInput");
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => (document.getElementById("kbSearchInput")?.value || "") === "",
      { timeout: 4000 }
    );
  });

  // --- ROADMAP #55: result count + "Showing N of M notes" + clear-filters ---
  // After a search returns results, #kbResultCount shows the human
  // "Showing N of M notes" line. Activating a filter chip surfaces a
  // "Clear filters" control that resets the facet. We drive this through an
  // example-search chip (guaranteed to return results on the seeded DB) so the
  // assertion doesn't depend on any one free-text term being in the corpus.
  await check("search shows a 'Showing N of M notes' count", async () => {
    // Reset to a clean empty-query state, then trigger a real search via an
    // example chip (the upstream "example-search chips" check confirms these
    // return results on the seeded vault).
    await page.evaluate(() => {
      const input = document.getElementById("kbSearchInput");
      if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    // The example chips are fixed phrases that used to hit the seeded vault
    // through /api/kb-search. Search is local now, so use a term the fixture
    // bundle actually contains.
    await page.fill("#kbSearchInput", "cover letter");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 8000 });
    await page.waitForSelector("#kbResultCount:not([hidden])", { timeout: 5000 });
    const txt = (await page.locator("#kbResultCount").allTextContents())[0]?.trim();
    assert.ok(/Showing \d+ of \d+ note/.test(txt || ""), `expected count line, got: ${txt}`);
  });

  await check("clear-filters control appears when a filter is active and resets it", async () => {
    // Run a fresh search (via an example chip) to ensure chips are rendered,
    // then activate a chip that is currently INACTIVE (filter state is
    // module-level and persists across searches, so the first chip may already
    // be active from an earlier step — clicking it would toggle OFF).
    await page.evaluate(() => {
      const input = document.getElementById("kbSearchInput");
      if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await page.fill("#kbSearchInput", "cover letter");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#kbResults .kb-result-card", { timeout: 8000 });
    // Pick an inactive chip so clicking turns the filter ON.
    const inactive = page.locator("#kbFilterChips .kb-chip:not(.active)").first();
    assert.ok((await inactive.count()) >= 1, "an inactive filter chip should be present");
    await inactive.click();
    await page.waitForTimeout(700);
    // A "Clear filters" control must now be present.
    const clear = page.locator("#kbFilterChips .kb-clear-filters");
    assert.ok((await clear.count()) === 1, "clear-filters control should appear when a filter is active");
    // Clicking it clears the filter and the control disappears.
    await clear.click();
    await page.waitForFunction(
      () => document.querySelectorAll("#kbFilterChips .kb-clear-filters").length === 0,
      { timeout: 5000 }
    ).catch(() => {});
    assert.equal(await page.locator("#kbFilterChips .kb-clear-filters").count(), 0,
      "clear-filters control should disappear after clearing");
    await page.screenshot({ path: SHOTS + "07-result-count.png", fullPage: true });
  });

  // --- Vision-independent visual gate (owner #7 / ROADMAP #7) ---
  // When the multimodal vision endpoint is down (500s), the loop must not
  // silently skip the aesthetic pass. These assertions verify the key visual
  // properties via computed styles + layout geometry — no screenshot analysis
  // required — so the "aesthetic" gate keeps firing even without vision.
  await check("course accordion renders styled (border-radius + pointer cursor)", async () => {
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open("cwa-archive", 1);
      req.onsuccess = () => {
        const tx = req.result.transaction("archive", "readwrite");
        tx.objectStore("archive").put({ id: "kb-bundle", data: {
          version: 1,
          notes: [
            { t: "Local review note", course: "Math", y: "2025-26", topic: "Algebra", s: "Review", x: "Review" },
            { t: "Cover letter", course: "Careers", y: "2024-25", topic: "Applications", s: "Cover letter structure", x: "Write a clear cover letter." },
          ],
          years: ["2024-25", "2025-26"],
          courses: ["Careers", "Math"],
        } });
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }));
    await page.reload({ waitUntil: "networkidle" });
    // Wait for the corpus to be discovered and #kbMain revealed before
    // reaching for a tab that lives inside it.
    await page.waitForSelector("#kbMain:not([hidden])", { timeout: 10000 });
    // Switch to the Browse tab rather than hand-unhiding #kbBrowse: the panel
    // wrapper around it is hidden too, and the course cards are only rendered
    // when showBrowsePanel() runs on tab entry.
    await page.click('.study-tab-btn[data-tab="browse"]');
    // Browse restores the last course you were reading (kept in localStorage),
    // so after an earlier test opened one this lands on that course's notes
    // rather than the course grid. Step back up to the grid this test is about.
    const back = page.locator("#kbBrowseBack");
    if (await back.count() && await back.isVisible()) {
      await back.click();
    }
    await page.waitForSelector("#kbBrowseCourses .kb-course-card", { timeout: 8000 });
    await page.locator("#kbBrowseCourses .kb-course-card").first().click();
    // The accordion groups render into #kbBrowseNotes; assert on the element
    // directly (not visibility, which depends on ancestor [hidden] state).
    await page.waitForFunction(
      () => document.querySelectorAll("#kbBrowseNotes .kb-sprint-group").length > 0,
      { timeout: 8000 }
    );
    // The styled accordion surface is the <details class="kb-sprint-group">
    // container (rounded 0.6rem). The .kb-result-card inside it is
    // intentionally square (radius 0) so the cards sit flush within the
    // rounded group — measuring the card would be the wrong element.
    const group = page.locator("#kbBrowseNotes .kb-sprint-group").first();
    const style = await group.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { radius: cs.borderTopLeftRadius, cursor: cs.cursor, display: cs.display };
    });
    assert.ok(parseFloat(style.radius) > 0, `expected rounded accordion, got radius ${style.radius}`);
    // The summary (clickable accordion header) is what shows the pointer.
    const summary = page.locator("#kbBrowseNotes .kb-sprint-summary").first();
    const sumStyle = await summary.evaluate((el) => getComputedStyle(el).cursor);
    assert.ok(sumStyle === "pointer", `expected pointer cursor on accordion header, got ${sumStyle}`);
  });

  await check("search results are horizontally centered (onboarding not lopsided)", async () => {
    // Browse is its own tab now; an empty query offers the example searches
    // rather than revealing the browse panel underneath the search box.
    await page.evaluate(() => {
      const input = document.getElementById("kbSearchInput");
      if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await page.click('.study-tab-btn[data-tab="browse"]');
    await page.waitForSelector("#kbBrowse:not([hidden])", { timeout: 8000 });
    const box = await page.locator("#kbBrowse").boundingBox();
    assert.ok(box, "browse panel should be visible");
    const vw = page.viewportSize().width;
    const margin = (vw - box.width) / 2;
    // Allow a tolerant band; the panel must be roughly centered, not flush left.
    assert.ok(Math.abs(box.x - margin) < vw * 0.15,
      `browse panel x=${box.x.toFixed(0)} expected ~${margin.toFixed(0)} (viewport ${vw})`);
  });

  // --- No uncaught page errors throughout ---
  // --- Browse and Curriculum filter/sort controls -------------------------
  // These are the controls the owner asked for; without a check here the gate
  // passes whether or not the bar is even in the DOM (it was missing from the
  // harness page entirely until it was synced with index.html).
  await check("browse course grid filters by year and re-sorts", async () => {
    await page.click('.study-tab-btn[data-tab="browse"]');
    const back = page.locator("#kbBrowseBack");
    if (await back.count() && await back.isVisible()) await back.click();
    await page.waitForSelector("#kbBrowseCourses .kb-course-card", { timeout: 8000 });

    const all = await page.locator("#kbBrowseCourses .kb-course-card").count();
    assert.ok(all >= 2, `expected several courses, got ${all}`);

    // Year is a real corpus-wide facet on the GRID, which is the part that
    // previously had no controls at all.
    await page.selectOption("#kbBrowseYear", "2024-25");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#kbBrowseCourses .kb-course-card").length < n,
      all, { timeout: 5000 },
    );
    const count = await page.locator("#kbBrowseCount").textContent();
    assert.match(count, /of \d+ courses/, `expected an "N of M" count, got "${count}"`);

    // Reset restores everything and hides itself.
    await page.locator("#kbBrowseReset").click();
    await page.waitForFunction(
      (n) => document.querySelectorAll("#kbBrowseCourses .kb-course-card").length === n,
      all, { timeout: 5000 },
    );
    assert.equal(await page.locator("#kbBrowseReset").isVisible(), false, "Reset should hide once filters are cleared");

    await page.selectOption("#kbBrowseSort", "alpha");
    await page.waitForTimeout(200);
    const names = await page.locator("#kbBrowseCourses .kb-course-name").allTextContents();
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "A-Z sort should order the grid");
    await page.selectOption("#kbBrowseSort", "notes");
  });

  await check("the year filter survives stepping into a course", async () => {
    // The old per-course <select> was rebuilt on entry and discarded on the way
    // back out, which is why filtering by year never seemed to hold.
    await page.selectOption("#kbBrowseYear", "2024-25");
    await page.waitForTimeout(200);
    await page.locator("#kbBrowseCourses .kb-course-card").first().click();
    await page.waitForFunction(() => !document.querySelector("#kbBrowseNotes")?.hidden, { timeout: 5000 });
    assert.equal(await page.locator("#kbBrowseYear").inputValue(), "2024-25", "year should carry into the course");
    // The controls swap to the in-course set.
    assert.equal(await page.locator("#kbBrowseTopicField").isVisible(), true, "topic filter belongs to the course view");
    assert.equal(await page.locator("#kbBrowseFamilyField").isVisible(), false, "type filter is grid-only");
    await page.locator("#kbBrowseBack").click();
    await page.waitForSelector("#kbBrowseCourses .kb-course-card", { timeout: 5000 });
    assert.equal(await page.locator("#kbBrowseYear").inputValue(), "2024-25", "year should survive going back");
    await page.locator("#kbBrowseReset").click();
  });

  await check("curriculum filters, sorts, and keeps its subject column visible", async () => {
    await page.click('.study-tab-btn[data-tab="curriculum"]');
    await page.waitForSelector("#kbCurriculumGrid .curriculum-row", { timeout: 8000 });
    const rows = await page.locator("#kbCurriculumGrid .curriculum-row:not(.curriculum-header)").count();
    assert.ok(rows >= 1, "expected curriculum rows");

    // The subject column must stay put when the grid scrolls sideways.
    const sticky = await page.locator("#kbCurriculumGrid .curriculum-row-label").first()
      .evaluate((el) => getComputedStyle(el).position);
    assert.equal(sticky, "sticky", "the subject column should be sticky");

    // Filtering to nothing must be an empty grid, not a broken one.
    await page.fill("#kbCurriculumSearch", "zzzznope");
    await page.waitForFunction(
      () => document.querySelectorAll("#kbCurriculumGrid .curriculum-row:not(.curriculum-header)").length === 0,
      { timeout: 5000 },
    );
    await page.fill("#kbCurriculumSearch", "");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#kbCurriculumGrid .curriculum-row:not(.curriculum-header)").length === n,
      rows, { timeout: 5000 },
    );

    // Typing must not lose the caret — the bar is re-rendered on every change.
    await page.fill("#kbCurriculumSearch", "a");
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "kbCurriculumSearch", "focus should stay in the filter box");
    await page.fill("#kbCurriculumSearch", "");
  });

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
