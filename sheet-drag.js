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
/**
 * A drag that started on the sheet's CONTENT rather than on its handle.
 *
 * The handle is 28px of a 776px sheet, and it is not where a thumb lands. The
 * gesture people actually make is "pull the thing down", anywhere on it — but
 * the same finger movement is also how you scroll, so the two have to be told
 * apart. The rule is the one every native sheet uses: a downward drag is a
 * dismissal only when the content was ALREADY at the top when the finger went
 * down. Scrolled even one pixel in, the same movement scrolls back up and the
 * sheet stays put; at the bottom, an upward drag does nothing at all (the
 * sheet does not stretch), which is `sheetDragModel`'s existing behaviour.
 *
 * `startedAtTop` is sampled on touchstart, not read live: a drag that scrolls
 * the content to 0 and keeps going must not turn into a dismissal halfway.
 */
export function sheetContentDragModel({ startedAtTop = false, startY = 0, currentY = 0, height = 0, elapsedMs = 0 } = {}) {
  if (!startedAtTop) return { offset: 0, velocity: 0, dismiss: false };
  return sheetDragModel({ startY, currentY, height, elapsedMs });
}
