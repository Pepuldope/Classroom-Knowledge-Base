// pull_refresh_test.mjs — the gesture the standalone window took away.
//
// Reported by Pepuldo on 2026-09-10: "Im also testing this as a web app on
// iphone and there you cannot scroll up to refresh the site."
//
// Installed to the home screen, the page runs without browser chrome — and
// pull-to-refresh belongs to that chrome, so it went with it. There was then no
// way at all to ask Classroom for fresh data short of force-quitting the app,
// which is also why "New since yesterday" looked stuck: the list was right when
// it was built and was never built again.
//
// In an ordinary tab the engine still owns the gesture, so ours must stay out
// of the way there — that is the second half of this gate.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/pull_refresh_test.mjs
import { chromium } from "playwright";
import { openSignedInPage } from "./lib/harness.mjs";

const browser = await chromium.launch();
const COURSE = { id: "c1", name: "NaE Y3 3.T", section: "2025/26", creationTime: "2025-07-01T12:31:18.847Z", courseState: "ACTIVE" };
const soon = new Date(Date.now() + 86400000);
const WORKS = Array.from({ length: 8 }, (_, i) => ({
  id: `w${i}`, courseId: "c1", title: `Assignment number ${i + 1}`,
  workType: "ASSIGNMENT", state: "PUBLISHED",
  creationTime: new Date().toISOString(), updateTime: new Date().toISOString(),
  dueDate: { year: soon.getFullYear(), month: soon.getMonth() + 1, day: soon.getDate() },
  description: "Do the thing.",
}));

const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`✓ ${message}`);
  else { failures.push(message); console.log(`✗ ${message}`); }
};

/** A real, cancelable touch drag, with a hook to look at the page mid-gesture. */
async function touchDrag(page, { x, fromY, toY, steps = 14, stepMs = 16, onMove = null }) {
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

const indicatorState = (page) => page.evaluate(() => {
  const el = document.getElementById("pullRefresh");
  return {
    opacity: Number(getComputedStyle(el).opacity),
    armed: el.classList.contains("armed"),
    refreshing: el.classList.contains("refreshing"),
  };
});

const backend = {
  courses: [COURSE],
  courseWork: WORKS,
  submissions: WORKS.map((w) => ({ courseWorkId: w.id, state: "CREATED" })),
};

// --- 1. An ordinary tab: the engine's gesture, not ours -------------------
{
  const { page } = await openSignedInPage(browser, {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...backend,
  });
  await page.waitForSelector(".assignment", { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  let peak = 0;
  await touchDrag(page, {
    x: 195, fromY: 120, toY: 620,
    onMove: async () => { peak = Math.max(peak, (await indicatorState(page)).opacity); },
  });
  await page.waitForTimeout(300);
  check(peak === 0, "in a browser tab the indicator never appears — the engine's own pull-to-refresh is still there");
  await page.close();
}

// --- 2. Installed to the home screen -------------------------------------
{
  const { page, errors } = await openSignedInPage(browser, {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...backend,
  });
  // iOS home-screen apps predate the display-mode media query and report this
  // instead. Set before the document runs, then reload into it.
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
  });
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector(".assignment", { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  let courseCalls = 0;
  page.on("request", (r) => { if (r.url().includes("/courses?")) courseCalls += 1; });

  let armedDuringDrag = false;
  let sawIndicator = false;
  await touchDrag(page, {
    x: 195, fromY: 120, toY: 620,
    onMove: async () => {
      const state = await indicatorState(page);
      if (state.opacity > 0) sawIndicator = true;
      if (state.armed) armedDuringDrag = true;
    },
  });
  check(sawIndicator, "pulling down from the top brings the refresh indicator with it");
  check(armedDuringDrag, "pulling far enough arms it, so letting go means something");

  await page.waitForFunction(() => !document.getElementById("pullRefresh").classList.contains("refreshing"),
    null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  check(courseCalls > 0, `letting go re-asks Classroom (${courseCalls} courses request${courseCalls === 1 ? "" : "s"})`);
  check(await page.evaluate(() => document.querySelectorAll(".assignment").length) > 0,
    "the refreshed report renders, rather than blanking the page");
  check((await indicatorState(page)).opacity === 0, "the indicator parks itself again afterwards");

  // A short tug is a scroll, not a refresh.
  const before = courseCalls;
  await page.evaluate(() => window.scrollTo(0, 0));
  await touchDrag(page, { x: 195, fromY: 200, toY: 240, steps: 8, stepMs: 40 });
  await page.waitForTimeout(700);
  check(courseCalls === before, "a short tug does not refresh");

  check(errors.length === 0, `no uncaught page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await page.close();
}

await browser.close();
if (failures.length) {
  console.error(`\npull-to-refresh FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\npull-to-refresh tests passed");
