// pull-refresh.js — over-scroll at the top of the page, as a refresh.
//
// Installed to the iPhone home screen, this site runs in a standalone window:
// no address bar, and — the part that matters — no pull-to-refresh, because
// that gesture belongs to Safari's chrome and the chrome is gone. There was
// then NO way to ask the page for fresh Classroom data short of force-quitting
// the app, so a session opened on Monday was still showing Monday's list on
// Wednesday. ("New since yesterday" looked broken for exactly this reason: the
// list was correct when it was computed, and it was never computed again.)
//
// In a browser tab the engine still owns the gesture, so this stays off there
// rather than firing twice.

/** Damped pixels of pull needed to arm a refresh. */
export const PULL_TRIGGER_PX = 64;
/** The indicator stops following the finger here, however far it keeps going. */
export const PULL_MAX_PX = 96;
/** Finger travel is halved on the way to the indicator, so the pull has weight. */
export const PULL_DAMPING = 0.5;

/** Only where the platform has taken its own pull-to-refresh away. */
export function pullRefreshEnabled({ standalone = false } = {}) {
  return Boolean(standalone);
}

/**
 * True in an installed/standalone window, on either platform.
 *
 * iOS predates the display-mode media query for home-screen apps and reports
 * `navigator.standalone` instead; other engines only have the media query.
 */
export function isStandaloneDisplay({ displayModeStandalone = false, navigatorStandalone = false } = {}) {
  return Boolean(displayModeStandalone || navigatorStandalone);
}

/**
 * Resolve a pull in progress into how far the indicator has come and whether
 * letting go now should refresh.
 *
 * `scrollY > 0` means the reader is scrolling a long list, not pulling the top
 * of the page — and an upward drag is never a pull.
 */
export function pullRefreshModel({ startY = 0, currentY = 0, scrollY = 0, enabled = true, refreshing = false } = {}) {
  const idle = { distance: 0, armed: false, active: false };
  if (!enabled || refreshing) return idle;
  if (!Number.isFinite(Number(scrollY)) || Number(scrollY) > 0) return idle;
  const travel = Number(currentY) - Number(startY);
  if (!Number.isFinite(travel) || travel <= 0) return idle;
  const distance = Math.min(PULL_MAX_PX, travel * PULL_DAMPING);
  return { distance, armed: distance >= PULL_TRIGGER_PX, active: true };
}
