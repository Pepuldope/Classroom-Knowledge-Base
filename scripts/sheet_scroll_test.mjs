// sheet_scroll_test.mjs — the phone sheet scrolls itself, and the page behind
// it does not.
//
// Reported by Pepuldo on 2026-09-10, on an iPhone:
//   "you can scroll the site without scrolling the popup window when you press
//    into an assignment/material. You should be able to scroll the popup and
//    not the background page."
//
// Two separate causes, so two separate assertions:
//   1. only `.ai-messages` ever scrolled, and it is the LAST thing in the
//      sheet — a finger landing on the facts, the summary or the original
//      description found nothing scrollable and the touch fell through to the
//      document. The whole sheet body is one scroller now.
//   2. `overscroll-behavior` cannot help with a touch that starts on the
//      sheet's furniture (handle, header, ask box, quick prompts); iOS gives
//      that to the document regardless. The body is taken out of flow while
//      the sheet is open, and put back — at the same offset — when it closes.
//
// Plus the gesture he asked for: pull down from the TOP of the content to
// dismiss; once scrolled in, the same drag is a scroll and nothing else.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/sheet_scroll_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { openSignedInPage } from "./lib/harness.mjs";

const browser = await chromium.launch();
const COURSE = { id: "c1", name: "Náuka o podnikaní Y3 3.T", section: "2025/26", creationTime: "2025-07-01T12:31:18.847Z", courseState: "ACTIVE" };
const soon = new Date(Date.now() + 86400000);

// A long description and many attachments: the sheet has to have more content
// than it can show, or "does it scroll" is not a question.
const WORK = (i) => ({
  id: `w${i}`, courseId: "c1",
  title: `Prepare the investor pitch deck, part ${i}`,
  workType: "ASSIGNMENT", state: "PUBLISHED",
  alternateLink: "https://classroom.google.com/c/x/a/y/details",
  creationTime: new Date().toISOString(), updateTime: new Date().toISOString(),
  dueDate: { year: soon.getFullYear(), month: soon.getMonth() + 1, day: soon.getDate() },
  description: Array.from({ length: 30 }, (_, n) =>
    `Paragraph ${n + 1}: build the deck, rehearse the delivery, print the handouts.`).join("\n\n"),
  materials: Array.from({ length: 6 }, (_, n) => ({
    driveFile: { driveFile: { id: `d${n}`, title: `Handout number ${n + 1} for the pitch.pdf`, alternateLink: "https://drive.google.com/file/d/1" } },
  })),
});
const WORKS = Array.from({ length: 12 }, (_, i) => WORK(i + 1));

/** A real, cancelable touch drag — the kind the page is allowed to prevent. */
async function touchDrag(page, { x, fromY, toY, steps = 12, stepMs = 16 }) {
  const cdp = await page.context().newCDPSession(page);
  const point = (y) => [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(fromY) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: point(fromY + ((toY - fromY) * i) / steps),
    });
    await page.waitForTimeout(stepMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const openSheet = async (page) => {
  await page.locator(".assignment").first().click();
  await page.waitForSelector("#ai:not([hidden])", { timeout: 5000 });
  // Open the original description. Collapsed, this assignment's context fits
  // the sheet — and a sheet whose content fits is not a test of scrolling.
  // Expanded is also the case being reported: the long post you opened it for.
  await page.locator("#ai .original-desc summary").click();
  await page.waitForTimeout(500);
};

const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`✓ ${message}`);
  else { failures.push(message); console.log(`✗ ${message}`); }
};

// --- Phone ----------------------------------------------------------------
{
  const { page, errors } = await openSignedInPage(browser, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    courses: [COURSE],
    courseWork: WORKS,
    submissions: WORKS.map((w) => ({ courseWorkId: w.id, state: "CREATED" })),
  });
  await page.waitForSelector(".assignment", { timeout: 15000 });

  // Scroll the list first, so "the page behind did not move" is a real claim
  // and so restoring the offset on close is exercised.
  await page.evaluate(() => window.scrollTo(0, 240));
  await page.waitForTimeout(150);

  await openSheet(page);
  // What the lock recorded — not what was on screen before the tap, because
  // clicking a card scrolls it into view first.
  const lockedAt = await page.evaluate(() =>
    Math.round(-parseFloat(getComputedStyle(document.body).top) || 0));

  const geometry = await page.evaluate(() => {
    const scroller = document.getElementById("aiScroll");
    const messages = document.getElementById("aiMessages");
    return {
      scrollerOverflows: scroller.scrollHeight > scroller.clientHeight + 1,
      scrollerHeight: Math.round(scroller.clientHeight),
      scrollerContent: Math.round(scroller.scrollHeight),
      overscroll: getComputedStyle(scroller).overscrollBehaviorY,
      messagesScrolls: messages.scrollHeight > messages.clientHeight + 1,
      bodyPosition: getComputedStyle(document.body).position,
      bodyLocked: document.body.classList.contains("sheet-open"),
    };
  });
  check(geometry.scrollerOverflows,
    `the sheet body scrolls: ${geometry.scrollerContent}px of content in a ${geometry.scrollerHeight}px box`);
  check(!geometry.messagesScrolls, "the conversation is not a scroller inside a scroller");
  check(geometry.overscroll === "contain", `the sheet's scroll stays in the sheet (overscroll-behavior: ${geometry.overscroll})`);
  check(geometry.bodyLocked && geometry.bodyPosition === "fixed",
    `the page behind is held still (body position: ${geometry.bodyPosition})`);

  // Dragging on the sheet's furniture must not move the list behind it.
  const header = await page.evaluate(() => {
    const r = document.querySelector("#ai header").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await touchDrag(page, { x: header.x, fromY: header.y, toY: header.y - 200 });
  await page.waitForTimeout(200);
  check(await page.evaluate(() => window.scrollY) === 0,
    "a drag on the sheet's header leaves the document where the lock put it");

  // The content scrolls.
  const mid = await page.evaluate(() => {
    const r = document.getElementById("aiScroll").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.6 };
  });
  await touchDrag(page, { x: mid.x, fromY: mid.y, toY: mid.y - 220 });
  await page.waitForTimeout(300);
  const scrolledIn = await page.evaluate(() => document.getElementById("aiScroll").scrollTop);
  check(scrolledIn > 0, `dragging inside the popup scrolls the popup (${Math.round(scrolledIn)}px)`);

  // Scrolled in, a downward drag scrolls back — it does not close the sheet.
  await touchDrag(page, { x: mid.x, fromY: mid.y - 120, toY: mid.y + 60, steps: 10, stepMs: 40 });
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.getElementById("ai").hidden) === false,
    "scrolling back up mid-content does not dismiss the sheet");

  // Back at the top, the same pull is a dismissal.
  await page.evaluate(() => { document.getElementById("aiScroll").scrollTop = 0; });
  await page.waitForTimeout(200);
  const sheetHeight = await page.evaluate(() => document.getElementById("ai").getBoundingClientRect().height);
  await touchDrag(page, { x: mid.x, fromY: 300, toY: 300 + sheetHeight * 0.45, steps: 14, stepMs: 20 });
  await page.waitForTimeout(500);
  check(await page.evaluate(() => document.getElementById("ai").hidden) === true,
    `pulling down from the top of the content closes the sheet (${Math.round(sheetHeight * 0.45)}px)`);

  const restored = await page.evaluate(() => ({
    scrollY: window.scrollY,
    position: getComputedStyle(document.body).position,
  }));
  check(restored.position === "static", "the page is scrollable again once the sheet is gone");
  check(lockedAt > 0 && Math.abs(restored.scrollY - lockedAt) <= 2,
    `the list is back where it was left (${Math.round(restored.scrollY)}px, locked at ${lockedAt}px)`);

  check(errors.length === 0, `no uncaught page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await page.close();
}

// --- Desktop: the rail is untouched ---------------------------------------
{
  const { page } = await openSignedInPage(browser, {
    viewport: { width: 1280, height: 900 },
    courses: [COURSE],
    courseWork: WORKS,
    submissions: WORKS.map((w) => ({ courseWorkId: w.id, state: "CREATED" })),
  });
  await page.waitForSelector(".assignment", { timeout: 15000 });
  await openSheet(page);
  // The rail covers the right edge; the page under it is still a page.
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.waitForTimeout(150);
  const desktop = await page.evaluate(() => ({
    wrapper: getComputedStyle(document.getElementById("aiScroll")).display,
    messagesScrolls: (() => {
      const m = document.getElementById("aiMessages");
      return getComputedStyle(m).overflowY;
    })(),
    bodyPosition: getComputedStyle(document.body).position,
    scrollY: window.scrollY,
  }));
  check(desktop.wrapper === "contents", `the wrapper is not in the desktop layout at all (display: ${desktop.wrapper})`);
  check(desktop.messagesScrolls === "auto", "the conversation is still the scroller on desktop");
  check(desktop.bodyPosition === "static" && desktop.scrollY === 200,
    `the desktop page behind the rail still scrolls (scrollY ${desktop.scrollY}px, body ${desktop.bodyPosition})`);
  await page.close();
}

await browser.close();
if (failures.length) {
  console.error(`\nsheet scroll FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nsheet scroll tests passed");
