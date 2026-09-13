// notebook_test.mjs — Study → Notebook, which replaced "Saved" (2026-09-13).
//
// "Saved" listed whole tutor answers with a date and nothing else, and a pinned
// note was stored and synced but shown nowhere. This drives the real page:
// save part of an answer and the whole of one, find them under their class,
// rename one, search, follow a source back to its note, see a pin, delete one
// and undo it.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/notebook_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { openSignedInPage, seedKb } from "./lib/harness.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const NOTES = [
  { p: "0", t: "Všeobecný vzorec a diskriminant", course: "Y2 MAT", y: "2024-25", topic: "Rovnice", kind: "note", s: "Diskriminant", x: "D = b² - 4ac decides how many roots a quadratic has." },
  { p: "1", t: "Animal Farm - Chapter 7", course: "ELA Year 2", y: "2024-25", topic: "Sprint 3", kind: "note", s: "Napoleon", x: "Napoleon rewrites history in chapter seven." },
];
const BUNDLE = { version: 1, source: "classroom", generatedAt: new Date().toISOString(), years: ["2024-25"], courses: [], clusters: [], notes: NOTES };
const ANSWER = "The discriminant is D = b² - 4ac [1].\n\nIf D > 0 there are two real roots, if D = 0 one, and if D < 0 none.";

const browser = await chromium.launch();
let failed = false;
try {
  const { page, errors } = await openSignedInPage(browser, { base: BASE, viewport: { width: 1400, height: 1000 } });
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await seedKb(page, BUNDLE);
  await page.evaluate(async () => { localStorage.removeItem("cwa_tutor_study_list"); localStorage.removeItem("cwa_kb_pinned_notes"); const kb = await import("/kb.js"); await kb.showKbView(); });
  await page.waitForTimeout(500);

  assert.equal((await page.locator('.study-tab-btn[data-tab="saved"]').textContent()).trim(), "Notebook");
  await page.click('.study-tab-btn[data-tab="saved"]');
  assert.match(await page.locator("#kbSavedList").textContent(), /notebook is empty/i);
  console.log("✓ the tab is Notebook, and an empty one says how to fill it");

  // --- save from the tutor ---------------------------------------------------
  await page.evaluate((answer) => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (!String(url).includes("/api/tutor")) return realFetch(url, opts);
      const body = `data: ${JSON.stringify({ type: "sources", notes: [{ t: "Všeobecný vzorec a diskriminant", course: "Y2 MAT", y: "2024-25", noteIndex: 0 }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", "X-KB-Notes": "1" } });
    };
  }, ANSWER);
  await page.click('.study-tab-btn[data-tab="search"]');
  await page.click("#kbTutorOpen");
  await page.fill("#kbTutorInput", "Čo je diskriminant?");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#kbTutorMessages .ai-save-btn", { timeout: 10000 });

  // Select just the second paragraph, then save: only that is kept.
  const label = await page.evaluate(() => {
    const p = [...document.querySelectorAll('#kbTutorMessages [data-role="assistant"] p')].find((el) => /two real roots/.test(el.textContent));
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return new Promise((resolve) => setTimeout(() => resolve(document.querySelector("#kbTutorMessages .ai-save-btn").textContent), 50));
  });
  assert.equal(label, "Save selection", "the button does not say it will save the selection");
  await page.click("#kbTutorMessages .ai-save-btn");
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.waitForTimeout(1700);
  assert.equal(await page.locator("#kbTutorMessages .ai-save-btn").textContent(), "Save to notebook");
  await page.click("#kbTutorMessages .ai-save-btn");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("cwa_tutor_study_list")));
  assert.equal(saved.length, 2);
  assert.match(saved[0].text, /^If D > 0 there are two real roots/, "the selection save kept more than the selection");
  assert.ok(saved[1].text.startsWith("The discriminant is"), "the whole-answer save is not the whole answer");
  for (const record of saved) {
    assert.equal(record.question, "Čo je diskriminant?");
    assert.equal(record.course, "Y2 MAT");
    assert.match(record.sources, /Všeobecný vzorec a diskriminant/);
  }
  console.log("✓ saving keeps the selection when there is one, the whole answer otherwise, with question, class and sources");
  await page.click("#kbTutorClose");

  // --- pin a note from a search result --------------------------------------
  await page.fill("#kbSearchInput", "Napoleon");
  await page.waitForSelector("#kbResults .kb-note-pin", { timeout: 8000 });
  await page.locator("#kbResults .kb-note-pin").first().click();

  // --- the Notebook ----------------------------------------------------------
  await page.click('.study-tab-btn[data-tab="saved"]');
  const groups = await page.evaluate(() => [...document.querySelectorAll(".kb-notebook-group")].map((g) => ({
    course: g.querySelector(".kb-notebook-course").firstChild.textContent,
    kinds: [...g.querySelectorAll(".kb-notebook-item")].map((i) => (i.classList.contains("is-pin") ? "pin" : "answer")),
  })));
  assert.deepEqual(groups, [
    { course: "ELA Year 2", kinds: ["pin"] },
    { course: "Y2 MAT", kinds: ["answer", "answer"] },
  ], "answers and the pin are not grouped by class");
  console.log("✓ answers and the pinned note are grouped by class");

  // Rename survives a re-render.
  const firstAnswer = page.locator(".kb-notebook-item.is-answer").first();
  await firstAnswer.locator(".kb-notebook-rename-btn").click();
  await page.fill(".kb-notebook-rename", "Discriminant formula");
  await page.keyboard.press("Enter");
  await page.fill("#kbNotebookSearch", "formula");
  await page.waitForTimeout(300);
  assert.deepEqual(await page.locator(".kb-notebook-title").allTextContents(), ["Discriminant formula"]);
  assert.match(await page.locator("#kbNotebookStatus").textContent(), /Showing 1 of 3/);
  await page.fill("#kbNotebookSearch", "vseobecny");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".kb-notebook-item").count(), 2, "search should ignore diacritics and include sources");
  await page.fill("#kbNotebookSearch", "");
  await page.waitForTimeout(300);
  console.log("✓ rename sticks; search filters by title and by source, ignoring diacritics");

  // A source opens its note.
  await page.locator(".kb-notebook-item.is-answer a.kb-notebook-source").first().click();
  await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
  assert.equal(await page.locator("#kbNoteTitle").textContent(), "Všeobecný vzorec a diskriminant");
  await page.click("#kbNoteClose");
  console.log("✓ a source chip opens the note the answer came from");

  // Delete, then undo.
  const before = await page.locator(".kb-notebook-item").count();
  await page.locator(".kb-notebook-item.is-pin .is-danger").click();
  assert.equal(await page.locator(".kb-notebook-item").count(), before - 1);
  assert.match(await page.locator("#kbNotebookStatus").textContent(), /Unpinned “Animal Farm - Chapter 7”/);
  await page.click("#kbNotebookStatus .is-undo");
  assert.equal(await page.locator(".kb-notebook-item").count(), before, "Undo did not bring the pin back");
  console.log("✓ delete asks for no dialog and can be undone");

  // Geometry: nothing overflows at phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, "the Notebook scrolls sideways at 390px");
  console.log("✓ no sideways scroll at 390px");

  assert.deepEqual(errors, []);
} catch (e) {
  failed = true;
  console.error("✗", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
