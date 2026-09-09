// sheet-drag.js — the bottom sheet's grab handle, as an actual gesture.
//
// The handle was a `::before` pseudo-element carrying `pointer-events: none`.
// It looked exactly like the thing you pull a sheet down by, and pulling it did
// nothing but scroll the page behind — an affordance that lies is worse than no
// affordance at all. The handle is a real element now, and this module decides
// what a drag on it means, away from the DOM so every branch is testable.

/** Below this fraction of the sheet's height a drag is a wobble, not a dismissal. */
export const SHEET_DISMISS_RATIO = 0.25;
/** A quick flick counts even when it is short. Downward px per ms. */
export const SHEET_DISMISS_VELOCITY = 0.5;
/** Under this a flick is indistinguishable from the jitter of a tap. */
export const SHEET_FLICK_MIN_PX = 24;

/**
 * Resolve a drag in progress (or just ended) into an offset and a verdict.
 *
 * `offset` is what the sheet should be translated by right now; `dismiss` is
 * whether letting go here should close it.
 */
export function sheetDragModel({ startY = 0, currentY = 0, height = 0, elapsedMs = 0 } = {}) {
  const travel = Number(currentY) - Number(startY);
  // Upward drags do not stretch the sheet — it is already near-fullscreen — so
  // they resolve to a no-op rather than lifting it off the bottom edge.
  const offset = Number.isFinite(travel) && travel > 0 ? travel : 0;
  const h = Number(height) > 0 ? Number(height) : 0;
  const ms = Number(elapsedMs);
  const velocity = Number.isFinite(ms) && ms > 0 ? offset / ms : 0;
  const draggedFar = h > 0 && offset >= h * SHEET_DISMISS_RATIO;
  const flicked = offset >= SHEET_FLICK_MIN_PX && velocity >= SHEET_DISMISS_VELOCITY;
  return { offset, velocity, dismiss: draggedFar || flicked };
}

/**
 * How much of the viewport the browser's own chrome is covering at the bottom.
 *
 * On a phone the address/search bar sits at the BOTTOM of the screen and is not
 * part of the visual viewport, but `position: fixed; bottom: 0` still measures
 * against the layout viewport — so the sheet's last row of buttons rendered
 * underneath it. The on-screen keyboard obscures the same edge the same way.
 * `visualViewport` is the only thing that reports either.
 */
export function viewportBottomInset({ innerHeight = 0, visualHeight = 0, visualOffsetTop = 0 } = {}) {
  const layout = Number(innerHeight);
  const visual = Number(visualHeight);
  const offset = Number(visualOffsetTop) || 0;
  if (!Number.isFinite(layout) || !Number.isFinite(visual) || visual <= 0) return 0;
  const hidden = layout - visual - offset;
  // Sub-pixel viewport arithmetic is noisy; a stray 0.5px inset is not worth a
  // relayout, and a negative one means the visual viewport is the taller of the
  // two (pinch-zoom), which obscures nothing.
  return hidden > 1 ? Math.round(hidden) : 0;
}
