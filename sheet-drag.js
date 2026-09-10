// sheet-drag.js — the bottom sheet's grab handle, as an actual gesture.
//
// The handle was a `::before` pseudo-element carrying `pointer-events: none`.
// It looked exactly like the thing you pull a sheet down by, and pulling it did
// nothing but scroll the page behind — an affordance that lies is worse than no
// affordance at all. The handle is a real element now, and this module decides
// what a drag on it means, away from the DOM so every branch is testable.

/**
 * How far the sheet moves per pixel of finger.
 *
 * 1:1 was the obvious first answer and it reads as too eager — "it feels too
 * fast" (Pepuldo, 2026-09-11). Resistance is what makes a sheet feel like an
 * object with weight rather than something stuck to your thumb. 0.6 was chosen
 * from three; SHEET_DISMISS_RATIO below is scaled to match, so the amount of
 * FINGER travel needed to dismiss is roughly where it was at 1:1.
 */
export const SHEET_DRAG_DAMPING = 0.6;
/** Below this fraction of the sheet's height a drag is a wobble, not a dismissal. */
export const SHEET_DISMISS_RATIO = 0.15;
/** A quick flick counts even when it is short. Downward px per ms OF FINGER. */
export const SHEET_DISMISS_VELOCITY = 0.5;
/** Under this a flick is indistinguishable from the jitter of a tap. Finger px. */
export const SHEET_FLICK_MIN_PX = 24;
/** Finger travel a content drag must clear before it means anything. */
export const SHEET_GESTURE_SLOP = 10;

/** How long the sheet takes to spring back when the pull was not enough. */
export const SHEET_SETTLE_MS = 200;
/** Floor for how fast a dismissed sheet leaves the screen. Sheet px per ms. */
export const SHEET_THROW_SPEED = 2.4;
/** A throw is never snappier than this, however short the remaining distance. */
export const SHEET_THROW_MIN_MS = 130;
/** ...nor slower than this, however far it still has to go. */
export const SHEET_THROW_MAX_MS = 340;

/**
 * How long a dismissed sheet should take to finish leaving.
 *
 * Reported 2026-09-11: released halfway down, the sheet "kind of looks like it
 * immediately disappears instead of continuing on its trajectory". A fixed
 * duration is why: the same 200ms covered 572px when the sheet was released
 * near the top and 78px when it was released near the bottom, so the first
 * case was a blur and read as a cut rather than a movement.
 *
 * Distance over speed instead, so the sheet leaves at a consistent pace from
 * wherever it was let go — and at least as fast as the finger was already
 * moving it, because a throw that is slower than the hand that threw it is the
 * other way to look wrong.
 */
export function sheetThrowDuration({ offset = 0, height = 0, velocity = 0 } = {}) {
  const h = Number(height) > 0 ? Number(height) : 0;
  const remaining = Math.max(0, h - (Number(offset) || 0));
  // `velocity` is the finger; the sheet is moving at the damped fraction of it.
  const released = Math.max(0, Number(velocity) || 0) * SHEET_DRAG_DAMPING;
  const speed = Math.max(SHEET_THROW_SPEED, released);
  const ms = remaining / speed;
  return Math.min(SHEET_THROW_MAX_MS, Math.max(SHEET_THROW_MIN_MS, Math.round(ms)));
}

/**
 * Resolve a drag in progress (or just ended) into an offset and a verdict.
 *
 * Two different distances live in here and confusing them is a bug:
 *   `travel` is the FINGER, in px, past `slop`;
 *   `offset` is the SHEET, which lags it by SHEET_DRAG_DAMPING.
 * Speed is judged on the finger (how fast someone flicks is a fact about their
 * hand), distance on the sheet (how far it has actually come is what the eye
 * is deciding on).
 *
 * `slop` is subtracted before anything else so a gesture that has just been
 * recognised does not start with the sheet already jumped 10px down the screen.
 */
export function sheetDragModel({ startY = 0, currentY = 0, height = 0, elapsedMs = 0, slop = 0 } = {}) {
  const raw = Number(currentY) - Number(startY) - Number(slop);
  // Upward drags do not stretch the sheet — it is already near-fullscreen — so
  // they resolve to a no-op rather than lifting it off the bottom edge.
  const travel = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const offset = travel * SHEET_DRAG_DAMPING;
  const h = Number(height) > 0 ? Number(height) : 0;
  const ms = Number(elapsedMs);
  const velocity = Number.isFinite(ms) && ms > 0 ? travel / ms : 0;
  const draggedFar = h > 0 && offset >= h * SHEET_DISMISS_RATIO;
  const flicked = travel >= SHEET_FLICK_MIN_PX && velocity >= SHEET_DISMISS_VELOCITY;
  return { travel, offset, velocity, dismiss: draggedFar || flicked };
}

/**
 * What a gesture on the sheet's CONTENT turns out to have been.
 *
 * Reported 2026-09-11: "it sometimes gets confused whether you are scrolling
 * the popup content or trying to get rid of it". It was: the old rule was
 * "content at the top + any downward movement = dismissal", and a thumb
 * starting a scroll rarely moves in a straight line — the first few pixels of
 * a flick up are often a few pixels down. So the sheet grabbed the gesture
 * before there was anything to grab it on.
 *
 * A gesture is now UNDECIDED until it has moved `slop` px in some direction,
 * and then it commits, once, for the rest of the touch:
 *   - down, and more down than sideways, from the top -> "dismiss"
 *   - anything else -> "scroll", and it can never become a dismissal later.
 *
 * The commitment is the important half. Without it, scrolling to the top of
 * the content and continuing to pull turns into a dismissal mid-flick, which
 * is the same bug wearing a different hat.
 */
export function sheetGestureIntent({ startedAtTop = false, dx = 0, dy = 0, slop = SHEET_GESTURE_SLOP } = {}) {
  const x = Number(dx) || 0;
  const y = Number(dy) || 0;
  if (!startedAtTop) return "scroll";
  if (Math.max(Math.abs(x), Math.abs(y)) < Number(slop)) return "undecided";
  return y > 0 && Math.abs(y) > Math.abs(x) ? "dismiss" : "scroll";
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
export function sheetContentDragModel({ startedAtTop = false, startY = 0, currentY = 0, height = 0, elapsedMs = 0, slop = SHEET_GESTURE_SLOP } = {}) {
  if (!startedAtTop) return { travel: 0, offset: 0, velocity: 0, dismiss: false };
  return sheetDragModel({ startY, currentY, height, elapsedMs, slop });
}
