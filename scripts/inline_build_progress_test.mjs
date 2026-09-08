// inline_build_progress_test.mjs — accepting the "new courses" offer must not
// move the page.
//
// The full build card is 520px wide with a 140px log and `margin: 2rem auto`,
// and it renders ABOVE #kbMain. Dropping it in for a background top-up shoved
// every tab, filter and result down the screen. A rebuild started from the
// banner now reports progress in the banner itself.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto(`${BASE}/kb-test-harness.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(() => new Promise((res, rej) => {
    const req = indexedDB.open("cwa-archive", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("archive", { keyPath: "id" });
    req.onsuccess = () => {
      const notes = [{ p: "2025-26/vault/NaE/S1/a", t: "Pitch", course: "NaE Y3 3.T", y: "2025-26", topic: "S1", kind: "note", s: "s", x: "x" }];
      const tx = req.result.transaction("archive", "readwrite");
      tx.objectStore("archive").put({ id: "kb-bundle", data: { version: 1, notes, years: ["2025-26"] } });
      tx.oncomplete = () => { req.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    req.onerror = () => rej(req.error);
  }));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#kbView:not([hidden])", { timeout: 15000 });

  const measure = () => page.evaluate(() => {
    const banner = document.getElementById("kbChangesBanner");
    const tabs = document.getElementById("studyTabs");
    return {
      bannerHeight: Math.round(banner.getBoundingClientRect().height),
      bannerTop: Math.round(banner.getBoundingClientRect().top),
      tabsTop: Math.round(tabs.getBoundingClientRect().top),
      buildPanelHidden: document.getElementById("kbBuildPanel").hidden,
    };
  });

  // Raise the banner exactly as checkForClassroomChanges does.
  await page.evaluate(() => {
    const banner = document.getElementById("kbChangesBanner");
    banner.replaceChildren();
    const label = document.createElement("span");
    label.className = "kb-update-text";
    label.textContent = "1 new course in Google Classroom: MATURITA INFO Y4.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-btn";
    button.textContent = "Update now";
    banner.append(label, button);
    banner.hidden = false;
  });
  const before = await measure();
  assert.ok(before.bannerHeight > 0, "banner should be visible before the build");

  // Drive the real inline progress renderer through a build's worth of updates.
  await page.evaluate(async () => {
    const kb = await import("./kb.js");
    kb.__setInlineBuildActiveForTest(true);
    kb.__renderInlineBuildProgressForTest("Checking Google Classroom…", { percent: 5, onCancel: () => {} });
  });
  const during = await measure();

  assert.equal(during.buildPanelHidden, true, "the full build card must stay hidden for an inline build");
  assert.equal(during.bannerTop, before.bannerTop, `banner moved: ${before.bannerTop} -> ${during.bannerTop}`);
  assert.equal(during.tabsTop, before.tabsTop, `page content shifted by ${during.tabsTop - before.tabsTop}px`);
  assert.ok(Math.abs(during.bannerHeight - before.bannerHeight) <= 1,
    `banner changed height: ${before.bannerHeight}px -> ${during.bannerHeight}px`);

  // A long progress message must not grow the box either.
  await page.evaluate(async () => {
    const kb = await import("./kb.js");
    kb.__renderInlineBuildProgressForTest(
      "Reading coursework for a course with an extremely long name that would wrap onto several lines if it were allowed to",
      { percent: 60 });
  });
  const longMsg = await measure();
  assert.ok(Math.abs(longMsg.bannerHeight - before.bannerHeight) <= 1,
    `long progress message grew the banner: ${before.bannerHeight}px -> ${longMsg.bannerHeight}px`);
  assert.equal(longMsg.tabsTop, before.tabsTop, "long progress message shifted the page");

  // A cancel control is offered while the build runs.
  assert.equal(await page.locator("#kbChangesBanner button").textContent(), "Cancel");

  // The final result line has no button at all; the box must still not move.
  await page.evaluate(async () => {
    const kb = await import("./kb.js");
    kb.__clearInlineBuildProgressForTest({ message: "\u2705 Saved 1,204 notes locally in this browser." });
  });
  const finished = await measure();
  assert.ok(Math.abs(finished.bannerHeight - before.bannerHeight) <= 1,
    `result line changed the banner height: ${before.bannerHeight}px -> ${finished.bannerHeight}px`);
  assert.equal(finished.tabsTop, before.tabsTop, "result line shifted the page");

  await page.evaluate(async () => {
    const kb = await import("./kb.js");
    kb.__setInlineBuildActiveForTest(true);
    kb.__renderInlineBuildProgressForTest("Reading coursework\u2026", { percent: 60, onCancel: () => {} });
  });
  const barWidth = await page.evaluate(() => document.querySelector(".kb-update-progress-bar")?.style.width);
  assert.equal(barWidth, "60%", `progress bar should track the build, got ${barWidth}`);

  console.log(`✓ inline build progress keeps the page still (banner ${before.bannerHeight}px, tabs fixed at ${before.tabsTop}px)`);
} finally {
  await browser.close();
}
