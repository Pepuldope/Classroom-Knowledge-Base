// Pulling the bottom sheet's handle down, and what the browser hides behind it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  sheetDragModel,
  sheetContentDragModel,
  sheetGestureIntent,
  viewportBottomInset,
  SHEET_DISMISS_RATIO,
  SHEET_FLICK_MIN_PX,
  SHEET_DRAG_DAMPING,
  SHEET_GESTURE_SLOP,
  sheetThrowDuration,
  SHEET_THROW_MIN_MS,
  SHEET_THROW_MAX_MS,
  SHEET_THROW_SPEED,
} from "../sheet-drag.js";

const SHEET = 776; // 92% of an 844px phone

test("the sheet lags the finger rather than sticking to it", () => {
  // "The popup moving with your finger may need some smoothing or slowdown
  // coz it feels too fast" — Pepuldo, 2026-09-11. It resists now.
  const d = sheetDragModel({ startY: 100, currentY: 160, height: SHEET, elapsedMs: 400 });
  assert.equal(d.travel, 60, "the finger moved 60px");
  assert.equal(d.offset, 60 * SHEET_DRAG_DAMPING, "the sheet came less far than the finger");
  assert.ok(d.offset < d.travel, "resistance, not adhesion");
  assert.equal(d.dismiss, false);
});

test("dismissal is measured on the sheet, at roughly the finger distance it always was", () => {
  const far = Math.ceil((SHEET * SHEET_DISMISS_RATIO) / SHEET_DRAG_DAMPING);
  assert.equal(sheetDragModel({ startY: 0, currentY: far, height: SHEET, elapsedMs: 2000 }).dismiss, true);
  assert.equal(sheetDragModel({ startY: 0, currentY: far - 4, height: SHEET, elapsedMs: 2000 }).dismiss, false);
  // The damping was compensated, not stacked on top: the finger still travels
  // about a quarter of the sheet to close it, as it did at 1:1.
  assert.ok(Math.abs(far / SHEET - 0.25) < 0.02, `finger travel to dismiss is ${(far / SHEET).toFixed(3)} of the sheet`);
});

test("speed is judged on the finger, not on the sheet it is dragging", () => {
  // Damping must not make a flick 1.7x harder: how fast someone flicks is a
  // fact about their hand, and it is the same hand as before.
  const flick = sheetDragModel({ startY: 0, currentY: 80, height: SHEET, elapsedMs: 100 });
  assert.equal(flick.velocity, 0.8, "80px of finger in 100ms");
  assert.equal(flick.dismiss, true);
});

test("a tap is not a flick", () => {
  // A finger wobbles a few pixels in the ~30ms of a tap, which is an enormous
  // velocity and must not close the sheet the tap just opened.
  const tap = sheetDragModel({ startY: 0, currentY: SHEET_FLICK_MIN_PX - 1, height: SHEET, elapsedMs: 10 });
  assert.equal(tap.dismiss, false);
});

test("the first few pixels of a gesture do not move the sheet at all", () => {
  // Otherwise a recognised gesture starts with the sheet already jumped.
  const justPast = sheetDragModel({ startY: 0, currentY: SHEET_GESTURE_SLOP + 10, height: SHEET, slop: SHEET_GESTURE_SLOP });
  assert.equal(justPast.travel, 10, "the slop is spent, not carried");
  assert.equal(sheetDragModel({ startY: 0, currentY: SHEET_GESTURE_SLOP, height: SHEET, slop: SHEET_GESTURE_SLOP }).offset, 0);
});

test("upward drags are a no-op, not a stretch", () => {
  const up = sheetDragModel({ startY: 400, currentY: 200, height: SHEET, elapsedMs: 120 });
  assert.equal(up.offset, 0, "the sheet stays anchored to the bottom edge");
  assert.equal(up.dismiss, false);
});

test("degenerate input never dismisses", () => {
  assert.equal(sheetDragModel().dismiss, false);
  assert.equal(sheetDragModel({ startY: 0, currentY: 300, height: 0, elapsedMs: 0 }).dismiss, false,
    "no height and no elapsed time is not evidence of a flick");
});

test("the bottom inset measures browser chrome the layout viewport cannot see", () => {
  // iPhone Safari, bottom address bar showing.
  assert.equal(viewportBottomInset({ innerHeight: 844, visualHeight: 764, visualOffsetTop: 0 }), 80);
  // Keyboard up: the same edge, much more of it.
  assert.equal(viewportBottomInset({ innerHeight: 844, visualHeight: 508, visualOffsetTop: 0 }), 336);
  // Desktop, and any headless browser: nothing is hidden, so nothing changes.
  assert.equal(viewportBottomInset({ innerHeight: 900, visualHeight: 900, visualOffsetTop: 0 }), 0);
  // Pinch-zoom scrolls the visual viewport within the layout one.
  assert.equal(viewportBottomInset({ innerHeight: 844, visualHeight: 400, visualOffsetTop: 444 }), 0);
  // Sub-pixel noise is not an inset.
  assert.equal(viewportBottomInset({ innerHeight: 844, visualHeight: 843.4, visualOffsetTop: 0 }), 0);
  assert.equal(viewportBottomInset({}), 0);
});


// --- Dragging the sheet's content, not its handle -------------------------
// The handle is 28px of a 776px sheet and is not where a thumb lands. Pulling
// the sheet itself has to dismiss it too — without stealing the scroll.

test("pulling down from the top of the content dismisses the sheet", () => {
  // Finger distance, which is slop plus the damped threshold.
  const far = SHEET_GESTURE_SLOP + Math.ceil((SHEET * SHEET_DISMISS_RATIO) / SHEET_DRAG_DAMPING);
  const d = sheetContentDragModel({
    startedAtTop: true, startY: 200, currentY: 200 + far, height: SHEET, elapsedMs: 500,
  });
  assert.ok(d.offset < far, "the sheet lags the finger here too");
  assert.equal(d.dismiss, true);
});

test("the same drag scrolls, and never dismisses, once the content is scrolled in", () => {
  const far = Math.ceil(SHEET / 2);
  const d = sheetContentDragModel({
    startedAtTop: false, startY: 200, currentY: 200 + far, height: SHEET, elapsedMs: 500,
  });
  assert.equal(d.offset, 0, "the sheet does not follow a scrolling finger");
  assert.equal(d.dismiss, false);
});

test("reaching the bottom of the content does nothing at all", () => {
  // Pepuldo, 2026-09-10: scrolling DOWN should just reach the end. Only an
  // over-pull at the TOP closes the sheet.
  const d = sheetContentDragModel({
    startedAtTop: true, startY: 600, currentY: 100, height: SHEET, elapsedMs: 300,
  });
  assert.equal(d.offset, 0);
  assert.equal(d.dismiss, false);
});

test("a flick from the top counts even when it is short", () => {
  const d = sheetContentDragModel({
    startedAtTop: true, startY: 100,
    currentY: 100 + SHEET_GESTURE_SLOP + SHEET_FLICK_MIN_PX + 6, height: SHEET, elapsedMs: 40,
  });
  assert.equal(d.dismiss, true);
});


// --- Which gesture is this? ----------------------------------------------
// Reported 2026-09-11: "it sometimes gets confused whether you are scrolling
// the popup content or trying to get rid of it — mostly on the web app".

test("nothing is decided until the finger has actually gone somewhere", () => {
  assert.equal(sheetGestureIntent({ startedAtTop: true, dx: 0, dy: 4 }), "undecided");
  assert.equal(sheetGestureIntent({ startedAtTop: true, dx: 3, dy: -5 }), "undecided");
  assert.equal(sheetGestureIntent({ startedAtTop: true, dx: 0, dy: SHEET_GESTURE_SLOP }), "dismiss");
});

test("a scroll that begins with a few pixels of wobble stays a scroll", () => {
  // The reported confusion, exactly: a thumb starting a flick UP often moves a
  // few px DOWN first. Under the slop that is not a dismissal.
  assert.equal(sheetGestureIntent({ startedAtTop: true, dx: 1, dy: 6 }), "undecided");
  // ...and once it commits upward it is a scroll.
  assert.equal(sheetGestureIntent({ startedAtTop: true, dx: 1, dy: -40 }), "scroll");
});

test("a sideways gesture is never a dismissal", () => {
  // The library strip inside the sheet scrolls horizontally.
  assert.equal(sheetGestureIntent({ startedAtTop: true, dx: 60, dy: 20 }), "scroll");
  assert.equal(sheetGestureIntent({ startedAtTop: true, dx: -60, dy: 20 }), "scroll");
  assert.equal(sheetGestureIntent({ startedAtTop: true, dx: 20, dy: 60 }), "dismiss");
});

test("scrolled in even a pixel, a downward drag is only ever a scroll", () => {
  assert.equal(sheetGestureIntent({ startedAtTop: false, dx: 0, dy: 400 }), "scroll");
});


// --- Finishing the throw --------------------------------------------------
// Reported 2026-09-11: released halfway, the sheet "kind of looks like it
// immediately disappears instead of continuing on its trajectory".

test("the sheet leaves at a pace, not in a fixed number of milliseconds", () => {
  const early = sheetThrowDuration({ offset: 120, height: SHEET });
  const late = sheetThrowDuration({ offset: 700, height: SHEET });
  assert.ok(early > late, "further to go takes longer, which is what a pace means");
  assert.equal(early, Math.round((SHEET - 120) / SHEET_THROW_SPEED));
});

test("a sheet released halfway is visibly in flight, not a cut", () => {
  // The reported case: ~204px down a 776px sheet.
  const ms = sheetThrowDuration({ offset: 204, height: SHEET });
  assert.ok(ms > 200, `${ms}ms — longer than the flat 200ms that read as a jump`);
  assert.ok(ms <= SHEET_THROW_MAX_MS);
});

test("a throw is never slower than the hand that threw it", () => {
  const gentle = sheetThrowDuration({ offset: 100, height: SHEET, velocity: 0.2 });
  const hurled = sheetThrowDuration({ offset: 100, height: SHEET, velocity: 8 });
  assert.ok(hurled < gentle, "a fast flick keeps its speed on the way out");
  assert.ok(hurled >= SHEET_THROW_MIN_MS, "but never becomes a disappearance");
});

test("the duration is clamped at both ends", () => {
  assert.equal(sheetThrowDuration({ offset: SHEET, height: SHEET }), SHEET_THROW_MIN_MS,
    "nothing left to travel is still an animation, not a vanishing");
  assert.equal(sheetThrowDuration({ offset: 0, height: 4000 }), SHEET_THROW_MAX_MS);
  assert.equal(sheetThrowDuration(), SHEET_THROW_MIN_MS, "degenerate input does not divide by zero");
});
