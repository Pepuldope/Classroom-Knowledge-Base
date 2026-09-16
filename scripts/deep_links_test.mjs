// deep_links_test.mjs — Peter's second round, 2026-09-13.
//
//   3. the assignment panel's × sat below the middle of its button;
//   4. "Everything else pending" was grouped by class, not ordered by date;
//   5. in a note, the header's border ran through the "Pin note" button;
//   6. a pinned note in the Notebook opened only from an "Open note" button;
//   8. nothing could be middle-clicked into a new tab;
//   9. a note's meta line started at the card's left edge.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/deep_links_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { openSignedInPage, mockBackend, seedKb } from "./lib/harness.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const day = (n) => { const d = new Date(Date.now() + n * 86400000); return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }; };
const COURSES = [
  { id: "c1", name: "Art Y4", section: "2026/27", creationTime: "2026-07-01T00:00:00Z", courseState: "ACTIVE" },

];
const work = (id, courseId, title, due) => ({
  id, courseId, title, workType: "ASSIGNMENT", state: "PUBLISHED", alternateLink: "https://classroom.google.com/x",
  creationTime: new Date(Date.now() - 20 * 86400000).toISOString(), updateTime: new Date(Date.now() - 20 * 86400000).toISOString(),
  ...(due ? { dueDate: day(due) } : {}), description: title,
});
// Due in 20 and 12 days: past "This week", so they land in "Everything else pending".
// One course: the harness answers every course with the same coursework.
// Titles run A→Z against their dates, so class or title order cannot pass.
const COURSEWORK = [work("w-art", "c1", "Art portfolio", 20), work("w-zoo", "c1", "Zoology essay", 12), work("w-none", "c1", "Sketchbook", null)];
const NOTES = [0, 1, 2].map((i) => ({ p: `${i}`, t: `Adjectives - Synonyms ${i}`, course: "ELA Y4 Omega", y: "2026-27", topic: "SPRINT 1", kind: "note", s: "synonyms adjectives", x: "Big → large.\n\nSmall → tiny." }));
const BUNDLE = { version: 1, source: "classroom", generatedAt: new Date().toISOString(), years: ["2026-27"], courses: [], clusters: [], notes: NOTES };
const backend = { courses: COURSES, courseWork: COURSEWORK, submissions: COURSEWORK.map((w) => ({ courseWorkId: w.id, state: "CREATED" })) };

const browser = await chromium.launch();
let failed = false;
try {
  const { page, errors } = await openSignedInPage(browser, { base: BASE, viewport: { width: 1400, height: 900 }, ...backend });
  const context = page.context();
  // A tab opened from the page is a new page in the same context: stub it too.
  await mockBackend(context, backend);

  // --- 4. everything else pending, by date --------------------------------
  await page.waitForSelector("#fullList .assignment", { state: "attached", timeout: 15000 });
  await page.evaluate(() => { document.getElementById("restWrap").open = true; });
  const full = await page.evaluate(() => [...document.querySelectorAll("#fullList .day-group")].map((g) => ({
    label: g.querySelector(".day-label").textContent,
    titles: [...g.querySelectorAll(".assignment")].map((c) => c.querySelector(".title-line .title").textContent),

  })));
  assert.deepEqual(full.map((g) => g.titles.join()), ["Zoology essay", "Art portfolio", "Sketchbook"], `not in date order: ${JSON.stringify(full)}`);
  assert.equal(full.at(-1).label, "No due date");
  console.log(`✓ everything else pending is by date: ${full.map((g) => g.label).join(" → ")}`);

  // --- 8. an assignment opens in a new tab --------------------------------
  const card = page.locator("#fullList .assignment").first();
  assert.match(await card.getAttribute("data-href"), /^#assignment=/);
  assert.match(await card.locator("a.card-title-link").getAttribute("href"), /^#assignment=w-zoo$/);
  const [assignmentTab] = await Promise.all([context.waitForEvent("page"), card.click({ button: "middle" })]);
  assert.equal(await page.locator("#ai").isHidden(), true, "a middle-click also opened it in this tab");
  await assignmentTab.waitForLoadState("domcontentloaded");
  await assignmentTab.waitForSelector("#ai:not([hidden])", { timeout: 20000 });
  assert.equal(await assignmentTab.locator("#aiTitle").textContent(), "Zoology essay");
  assert.equal(new URL(assignmentTab.url()).hash, "", "the address was not consumed, so a reload would reopen it");
  await assignmentTab.close();
  console.log("✓ middle-clicking an assignment opens it, and only it, in a new tab");

  // --- 3. the close × is centred -------------------------------------------
  await card.click();
  await page.waitForSelector("#ai:not([hidden])");
  const x = await page.evaluate(() => {
    const b = document.getElementById("aiClose").getBoundingClientRect();
    const i = document.querySelector("#aiClose .close-icon").getBoundingClientRect();
    return { dx: Math.abs((b.left + b.right) / 2 - (i.left + i.right) / 2), dy: Math.abs((b.top + b.bottom) / 2 - (i.top + i.bottom) / 2) };
  });
  assert.ok(x.dx <= 1 && x.dy <= 1, `the × is off centre by ${x.dx}px, ${x.dy}px`);
  console.log("✓ the assignment panel's × is centred in its button");
  await page.click("#aiClose");

  // --- notes -------------------------------------------------------------
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await seedKb(page, BUNDLE);
  await page.evaluate(async () => { const kb = await import("/kb.js"); await kb.showKbView(); });
  await page.fill("#kbSearchInput", "synonyms");
  await page.waitForSelector("#kbResults .kb-result-card .kb-related-preview-chip", { timeout: 10000 });

  const chip = page.locator("#kbResults .kb-related-preview-chip").first();
  const chipTitle = (await chip.textContent()).trim();
  assert.match(await chip.getAttribute("href"), /^#note=/, "a related chip is not a link");
  const [noteTab] = await Promise.all([context.waitForEvent("page"), chip.click({ modifiers: ["ControlOrMeta"] })]);
  assert.equal(await page.locator("#kbNoteModal").isHidden(), true, "Ctrl-click also opened the note in this tab");
  await noteTab.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 20000 });
  assert.equal(await noteTab.locator("#kbNoteTitle").textContent(), chipTitle);
  await noteTab.close();
  console.log(`✓ Ctrl-clicking a related chip opens "${chipTitle}" in a new tab`);

  const [cardTab] = await Promise.all([context.waitForEvent("page"), page.locator("#kbResults .kb-result-card .meta").first().click({ button: "middle" })]);
  await cardTab.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 20000 });
  await cardTab.close();
  console.log("✓ middle-clicking anywhere on a result card opens its note in a new tab");

  // --- 5 + 9. the note modal's meta line --------------------------------
  await page.locator("#kbResults .kb-result-card").first().click();
  await page.waitForSelector("#kbNoteModal:not([hidden])");
  const meta = await page.evaluate(() => {
    const card = document.querySelector("#kbNoteModal .modal-card").getBoundingClientRect();
    const header = document.querySelector("#kbNoteModal header").getBoundingClientRect();
    const metaEl = document.getElementById("kbNoteMeta");
    const range = document.createRange(); range.selectNodeContents(metaEl.firstChild);
    const pin = metaEl.querySelector(".kb-note-pin").getBoundingClientRect();
    return { textGap: Math.round(range.getBoundingClientRect().left - card.left), pinBelowHeader: pin.top >= header.bottom };
  });
  assert.ok(meta.textGap >= 16, `the meta line starts ${meta.textGap}px from the card edge`);
  assert.ok(meta.pinBelowHeader, "the header's border runs through the Pin note button");
  console.log(`✓ note meta sits ${meta.textGap}px in, and Pin note clears the header`);
  await page.locator("#kbNoteModal .kb-note-pin").click();
  await page.click("#kbNoteClose");

  // --- 6. a pinned note opens from its card ------------------------------
  await page.click('.study-tab-btn[data-tab="saved"]');
  await page.locator(".kb-notebook-item.is-pin .kb-notebook-meta").click();
  await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
  assert.equal(await page.locator(".kb-notebook-item.is-pin").getByText("Open note").count(), 0, "the redundant Open note button is back");
  await page.click("#kbNoteClose");
  console.log("✓ clicking a pinned note's card opens the note");

  assert.deepEqual(errors, []);
} catch (e) {
  failed = true;
  console.error("✗", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
