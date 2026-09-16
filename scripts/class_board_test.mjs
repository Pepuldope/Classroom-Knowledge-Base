// class_board_test.mjs — fixing a class's category by dragging it.
//
// Peter, 2026-09-16: "make people able to rearrange them as they please so they
// can fix errors." The rules guess from a course name; this is the correction.
//
// Driven with real pointer events at phone size, because that is the claim that
// needs proving: the HTML5 drag-and-drop API has no touch implementation, so
// the board is built on pointer events instead, and a gate that only moved a
// mouse would not notice if that regressed.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { openSignedInPage, seedKb } from "./lib/harness.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const note = (course, y, t) => ({ p: `${course}-${t}`, t, course, y, topic: "General", kind: "note", s: t, x: `${t} body text.` });
const BUNDLE = {
  version: 1, source: "classroom", generatedAt: new Date().toISOString(),
  years: ["2024-25"], courses: [], clusters: [],
  notes: [
    // deriveFamily cannot place this one — it is the case the board exists for.
    note("NaE Y3 3.T", "2024-25", "Pitching"),
    note("NaE Y3 3.T", "2024-25", "Market research"),
    note("Matematika Y4", "2024-25", "Quadratics"),
  ],
};

const browser = await chromium.launch();
let failed = false;
try {
  const { page, errors } = await openSignedInPage(browser, {
    base: BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await seedKb(page, BUNDLE);
  await page.evaluate(async () => { const kb = await import("/kb.js"); await kb.showKbView(); });
  await page.click('.study-tab-btn[data-tab="manage"]');
  await page.waitForSelector("#kbClassBoard .kb-board-card", { timeout: 8000 });

  const columnOf = (course) => page.evaluate((name) => {
    const card = [...document.querySelectorAll(".kb-board-card")].find((c) => c.dataset.course === name);
    return card ? card.closest(".kb-board-column").dataset.family : null;
  }, course);

  assert.equal(await columnOf("NaE Y3 3.T"), "", "a class the rules cannot place should start unsorted");
  assert.equal(await columnOf("Matematika Y4"), "Science/Math");
  console.log("✓ the board opens with the rules' own answer");

  // --- drag it, with touch-shaped pointer events ---------------------------
  // Into the column NEXT to it, and dropped at a point that is genuinely on a
  // 390px screen. Scrolling a far column into view first would move the card
  // out from under the starting coordinates, which is exactly the situation
  // the "Move to" menu exists for and is checked separately below.
  const TARGET_FAMILY = "Language";
  // The board sits below the database and export blocks; a thumb can only drag
  // what is on screen, and elementFromPoint only sees what is on screen.
  await page.evaluate(() => document.getElementById("kbClassBoard").scrollIntoView({ block: "center" }));
  await page.waitForTimeout(150);
  const geometry = await page.evaluate((family) => {
    const card = [...document.querySelectorAll(".kb-board-card")].find((c) => c.dataset.course === "NaE Y3 3.T");
    const column = document.querySelector(`.kb-board-column[data-family="${family}"]`);
    const c = card.getBoundingClientRect();
    const t = column.getBoundingClientRect();
    return {
      from: { x: c.left + c.width / 2, y: c.top + c.height / 2 },
      // Clamped into the viewport: a drop nobody could reach with a thumb
      // proves nothing, and elementFromPoint returns null off-screen.
      to: { x: Math.min(t.left + 20, window.innerWidth - 8), y: t.top + 30 },
      reachable: t.left < window.innerWidth - 8,
    };
  }, TARGET_FAMILY);
  assert.equal(geometry.reachable, true, "the target column is off-screen at 390px — the fixture, not the app");

  await page.evaluate(({ from, to }) => {
    const board = document.getElementById("kbClassBoard");
    const at = (type, p) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: p.x, clientY: p.y, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0,
    });
    const start = document.elementFromPoint(from.x, from.y);
    if (!start) throw new Error(`nothing at ${from.x},${from.y}`);
    start.dispatchEvent(at("pointerdown", from));
    // Past the slop, then across, in steps — a single jump would not exercise
    // the drop-target highlighting on the way.
    for (let i = 1; i <= 8; i++) {
      board.dispatchEvent(at("pointermove", {
        x: from.x + ((to.x - from.x) * i) / 8,
        y: from.y + ((to.y - from.y) * i) / 8,
      }));
    }
    board.dispatchEvent(at("pointerup", to));
  }, geometry);

  await page.waitForTimeout(250);
  assert.equal(await columnOf("NaE Y3 3.T"), TARGET_FAMILY, "dragging the card did not move it");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cwa_kb_class_families") || "[]"));
  assert.deepEqual(stored, [{ id: "NaE Y3 3.T", family: TARGET_FAMILY }]);
  console.log("✓ a touch drag moves a class and records the override");

  // --- it reaches the rest of the app --------------------------------------
  await page.click('.study-tab-btn[data-tab="search"]');
  await page.fill("#kbSearchInput", "pitching");
  await page.waitForSelector("#kbResults .kb-result-card", { timeout: 8000 });
  const families = await page.evaluate(() =>
    [...document.querySelectorAll("#kbFilterFamily option")].map((o) => o.value).filter(Boolean));
  assert.ok(families.includes(TARGET_FAMILY), `the class-type filter does not offer ${TARGET_FAMILY}: ${JSON.stringify(families)}`);
  console.log("✓ the correction reaches the class-type filter");

  // --- and it can be undone ------------------------------------------------
  await page.click('.study-tab-btn[data-tab="manage"]');
  await page.waitForSelector("#kbClassBoardReset:not([hidden])", { timeout: 5000 });
  await page.click("#kbClassBoardReset");
  await page.waitForTimeout(200);
  assert.equal(await columnOf("NaE Y3 3.T"), "", "putting everything back on automatic did not undo the move");
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("cwa_kb_class_families") || "[]")), []);
  console.log("✓ putting a class back on automatic really puts it back");

  // --- the phone-friendly path -------------------------------------------
  await page.selectOption('.kb-board-card[data-course="NaE Y3 3.T"] .kb-board-card-move', "Arts");
  await page.waitForTimeout(200);
  assert.equal(await columnOf("NaE Y3 3.T"), "Arts", "the Move to menu did nothing");
  console.log("✓ the Move to menu does the same job without a drag");

  assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
} catch (e) {
  failed = true;
  console.error("✗", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
