// Over-scroll at the top of the page, in the window that has no chrome to do it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  pullRefreshModel,
  pullRefreshEnabled,
  isStandaloneDisplay,
  PULL_TRIGGER_PX,
  PULL_MAX_PX,
  PULL_DAMPING,
} from "../pull-refresh.js";
import { reportIsStale, localDayKey, REPORT_MAX_AGE_MS } from "../report-freshness.js";

test("the gesture is ours only where the platform gave it up", () => {
  // In a tab the engine still owns it; adding ours would refresh twice.
  assert.equal(pullRefreshEnabled({ standalone: false }), false);
  assert.equal(pullRefreshEnabled({ standalone: true }), true);
  // iOS home-screen apps predate display-mode and report navigator.standalone.
  assert.equal(isStandaloneDisplay({ navigatorStandalone: true }), true);
  assert.equal(isStandaloneDisplay({ displayModeStandalone: true }), true);
  assert.equal(isStandaloneDisplay({}), false);
});

test("a pull only counts from the very top of the page", () => {
  const pull = { startY: 100, currentY: 300, enabled: true };
  assert.equal(pullRefreshModel({ ...pull, scrollY: 0 }).active, true);
  assert.equal(pullRefreshModel({ ...pull, scrollY: 1 }).active, false,
    "one pixel in, this is a scroll back up the list");
});

test("the indicator lags the finger and stops at the cap", () => {
  const short = pullRefreshModel({ startY: 0, currentY: 40, scrollY: 0 });
  assert.equal(short.distance, 40 * PULL_DAMPING);
  assert.equal(short.armed, false);

  const armed = pullRefreshModel({ startY: 0, currentY: PULL_TRIGGER_PX / PULL_DAMPING, scrollY: 0 });
  assert.equal(armed.armed, true);

  const heaved = pullRefreshModel({ startY: 0, currentY: 4000, scrollY: 0 });
  assert.equal(heaved.distance, PULL_MAX_PX, "the indicator stops following");
});

test("an upward drag, a disabled gesture and a refresh in flight are all no-ops", () => {
  assert.equal(pullRefreshModel({ startY: 300, currentY: 100, scrollY: 0 }).active, false);
  assert.equal(pullRefreshModel({ startY: 0, currentY: 400, scrollY: 0, enabled: false }).active, false);
  assert.equal(pullRefreshModel({ startY: 0, currentY: 400, scrollY: 0, refreshing: true }).active, false);
});

// --- The other half of the same bug --------------------------------------

test("a list built on another day is stale however recently it was built", () => {
  const built = new Date("2026-09-09T23:58:00").getTime();
  const justAfterMidnight = new Date("2026-09-10T00:01:00").getTime();
  assert.equal(reportIsStale({ loadedAt: built, now: justAfterMidnight }), true,
    "three minutes old, but 'new since yesterday' now means something else");
});

test("a list from earlier today is stale only once it is old", () => {
  const built = new Date("2026-09-10T09:00:00").getTime();
  assert.equal(reportIsStale({ loadedAt: built, now: built + 60_000 }), false);
  assert.equal(reportIsStale({ loadedAt: built, now: built + REPORT_MAX_AGE_MS }), true);
});

test("no list yet is not a stale list", () => {
  assert.equal(reportIsStale({ loadedAt: 0, now: Date.now() }), false);
});

test("the day key is local, not UTC", () => {
  // 01:30 in Bratislava on the 10th is 23:30 UTC on the 9th; the section is
  // named after the reader's calendar, not Greenwich's.
  assert.equal(localDayKey(new Date(2026, 8, 10, 1, 30)), "2026-09-10");
});
