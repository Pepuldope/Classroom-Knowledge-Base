// Pulling the bottom sheet's handle down, and what the browser hides behind it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  sheetDragModel,
  viewportBottomInset,
  SHEET_DISMISS_RATIO,
  SHEET_FLICK_MIN_PX,
} from "../sheet-drag.js";

const SHEET = 776; // 92% of an 844px phone

test("a short, slow drag follows the finger but does not dismiss", () => {
  const d = sheetDragModel({ startY: 100, currentY: 160, height: SHEET, elapsedMs: 400 });
  assert.equal(d.offset, 60, "the sheet tracks the finger");
  assert.equal(d.dismiss, false, `60px is under the ${SHEET_DISMISS_RATIO} threshold`);
});

test("dragging past a quarter of the sheet dismisses it", () => {
  const far = Math.ceil(SHEET * SHEET_DISMISS_RATIO);
  assert.equal(sheetDragModel({ startY: 0, currentY: far, height: SHEET, elapsedMs: 2000 }).dismiss, true);
  assert.equal(sheetDragModel({ startY: 0, currentY: far - 1, height: SHEET, elapsedMs: 2000 }).dismiss, false);
});

test("a quick flick dismisses without travelling far", () => {
  // 80px in 100ms — the gesture people actually make.
  const flick = sheetDragModel({ startY: 0, currentY: 80, height: SHEET, elapsedMs: 100 });
  assert.equal(flick.dismiss, true);
  assert.ok(flick.velocity >= 0.5);
});

test("a tap is not a flick", () => {
  // A finger wobbles a few pixels in the ~30ms of a tap, which is an enormous
  // velocity and must not close the sheet the tap just opened.
  const tap = sheetDragModel({ startY: 0, currentY: SHEET_FLICK_MIN_PX - 1, height: SHEET, elapsedMs: 10 });
  assert.equal(tap.dismiss, false);
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
