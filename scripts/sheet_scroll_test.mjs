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
async function touchDrag(page, { x, fromY, toY, steps = 12, stepMs = 16, onMove = null }) {
  const cdp = await page.context().newCDPSession(page);
  const point = (y) => [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(fromY) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: point(fromY + ((toY - fromY) * i) / steps),
    });
    await page.waitForTimeout(stepMs);
    if (onMove) await onMove(i / steps);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** How far down the sheet is currently drawn, in px. */
const sheetOffset = (page) => page.evaluate(() => {
  const t = getComputedStyle(document.getElementById("ai")).transform;
  if (!t || t === "none") return 0;
  const m = new DOMMatrixReadOnly(t);
  return Math.round(m.m42);
});

/**
 * Two invariants that only an EXPANDED original description exercises.
 *
 * `spill`: a box that clips nothing must not be given a height that clips.
 * A `max-height` left standing under `overflow: visible` is not a scroller, it
 * is text running out of its own box and over whatever is underneath.
 *
 * `askBoxAtBottom`: the ask box and the quick prompts sit on the panel's floor.
 * They ride up under the content the moment the sheet's body stops being the
 * element that takes the slack.
 */
const panelInvariants = (page) => page.evaluate(() => {
  const panel = document.getElementById("ai");
  const quick = document.querySelector("#ai .ai-quick");
  const style = getComputedStyle(panel);
  const clipped = [...panel.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    if (s.overflowY !== "visible" || s.maxHeight === "none") return false;
    return el.scrollHeight > el.clientHeight + 1;
  }).map((el) => `${el.className || el.tagName}: ${el.scrollHeight}px in a ${el.clientHeight}px box`);
  const floor = panel.getBoundingClientRect().bottom - parseFloat(style.paddingBottom || "0");
  return { clipped, gapBelowQuickPrompts: Math.round(floor - quick.getBoundingClientRect().bottom) };
});

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
  const phoneInvariants = await panelInvariants(page);
  check(phoneInvariants.clipped.length === 0,
    `nothing spills out of its own box with the description expanded${phoneInvariants.clipped.length ? ": " + phoneInvariants.clipped.join("; ") : ""}`);
  check(Math.abs(phoneInvariants.gapBelowQuickPrompts) <= 2,
    `the ask box and quick prompts sit on the sheet's floor (${phoneInvariants.gapBelowQuickPrompts}px gap below them)`);

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

  // Back at the top, the same pull is a dismissal — and it has to be VISIBLE
  // on the way. Requested 2026-09-10: "I would like it to follow with your
  // finger as you pull down so you have that feedback."
  await page.evaluate(() => { document.getElementById("aiScroll").scrollTop = 0; });
  await page.waitForTimeout(200);
  const sheetHeight = await page.evaluate(() => document.getElementById("ai").getBoundingClientRect().height);
  let followed = 0;
  await touchDrag(page, {
    x: mid.x, fromY: 300, toY: 300 + sheetHeight * 0.45, steps: 14, stepMs: 20,
    onMove: async () => { followed = Math.max(followed, await sheetOffset(page)); },
  });
  check(followed > 40, `the sheet follows the finger down (${followed}px at its furthest)`);
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

  // --- Tapping the page above the sheet -----------------------------------
  // Reported 2026-09-11: "when clicking above the popup, it needs to close the
  // popup without interacting with anything on the website. Currently it does
  // not close the popup, and interacts with the rest of the site so you can
  // accidentally switch pages."
  await page.locator(".assignment").first().click();
  await page.waitForSelector("#ai:not([hidden])", { timeout: 5000 });
  await page.waitForTimeout(500);
  const above = await page.evaluate(() => {
    const sheet = document.getElementById("ai").getBoundingClientRect();
    // Aim at a real control in the exposed strip — the menu button, which sits
    // in the header's top row. The sheet covers everything from 68px down, so
    // the view switcher is only half exposed; this is the one that is fully in
    // the strip, and it is the same class of accident (a dismissing tap that
    // does something else instead).
    const menu = document.getElementById("menuBtn").getBoundingClientRect();
    const scrim = document.getElementById("aiScrim").getBoundingClientRect();
    return {
      x: Math.round(menu.x + menu.width / 2),
      y: Math.round(menu.y + menu.height / 2),
      exposed: menu.bottom < sheet.top,
      scrimCovers: scrim.top <= 0 && scrim.bottom >= sheet.top,
      // What a tap there actually reaches. Before the scrim this was #menuBtn.
      hitTest: document.elementFromPoint(
        Math.round(menu.x + menu.width / 2), Math.round(menu.y + menu.height / 2))?.id || "",
      viewBefore: document.getElementById("kbView").hidden ? "planner" : "kb",
    };
  });
  check(above.exposed && above.scrimCovers && above.hitTest === "aiScrim",
    `the strip of page above the sheet is covered by the scrim (a tap at ${above.y}px reaches #${above.hitTest})`);
  await page.mouse.click(above.x, above.y);
  await page.waitForTimeout(400);
  const afterTap = await page.evaluate(() => ({
    sheetHidden: document.getElementById("ai").hidden,
    scrimHidden: document.getElementById("aiScrim").hidden,
    view: document.getElementById("kbView").hidden ? "planner" : "kb",
    menuOpen: !document.getElementById("menuPopover").hidden,
    bodyPosition: getComputedStyle(document.body).position,
  }));
  check(afterTap.sheetHidden, "tapping above the sheet closes it");
  check(!afterTap.menuOpen && afterTap.view === above.viewBefore,
    `and goes no further — the control under the tap did not fire, still on ${afterTap.view}`);
  check(afterTap.scrimHidden && afterTap.bodyPosition === "static",
    "the scrim goes with it and the page is live again");

  // The handle is the other way in, and it was pinned by the same fill mode.
  await page.locator(".assignment").first().click();
  await page.waitForSelector("#ai:not([hidden])", { timeout: 5000 });
  await page.waitForTimeout(500);
  const handle = await page.evaluate(() => {
    const r = document.getElementById("aiSheetHandle").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  let handleFollowed = 0;
  for (let y = handle.y; y <= handle.y + 120; y += 20) {
    await page.mouse.move(handle.x, y);
    await page.waitForTimeout(30);
    handleFollowed = Math.max(handleFollowed, await sheetOffset(page));
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  check(handleFollowed > 40, `the handle drags the sheet with it (${handleFollowed}px at its furthest)`);

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
  const desktopInvariants = await panelInvariants(page);
  check(desktopInvariants.clipped.length === 0,
    `nothing spills out of its own box on desktop either${desktopInvariants.clipped.length ? ": " + desktopInvariants.clipped.join("; ") : ""}`);
  check(Math.abs(desktopInvariants.gapBelowQuickPrompts) <= 2,
    `the ask box sits at the bottom of the desktop rail, not under the content (${desktopInvariants.gapBelowQuickPrompts}px gap below it)`);
  check(await page.evaluate(() => getComputedStyle(document.getElementById("aiScrim")).display) === "none",
    "no scrim on desktop — the page beside the rail is still meant to be clickable");
  check(desktop.wrapper === "flex", `the sheet body carries its own flex, rather than relying on display: contents (display: ${desktop.wrapper})`);
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
