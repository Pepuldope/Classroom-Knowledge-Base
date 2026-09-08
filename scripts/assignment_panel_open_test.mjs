// assignment_panel_open_test.mjs — tapping an assignment opens the panel at
// once, and does not raise the phone keyboard.
//
// openAi() used to `await loadChatHistory()` BEFORE showing the panel. That one
// await caused two reported symptoms at the same time:
//
//   - the sheet's slide-up began in a promise continuation, long after the tap,
//     so it read as "nothing, hitch, already open";
//   - `$("aiInput").focus()` landed outside the user-gesture task, and mobile
//     will not raise the keyboard from there. On a cache HIT there was no await
//     at all, so focus stayed inside the gesture and the keyboard DID appear —
//     which is why it happened on exactly every other open.
//
// The panel is now shown synchronously and the conversation loaded afterwards,
// and the input is never focused on a touch device.
import { chromium, devices } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

const COURSE = { id: "c1", name: "NaE Y3 3.T", section: "2025/26", creationTime: "2025-07-01T12:31:18.847Z", courseState: "ACTIVE" };
const tomorrow = new Date(Date.now() + 86400000);
const WORK = {
  id: "w1", courseId: "c1", title: "Prepare the pitch deck", workType: "ASSIGNMENT",
  state: "PUBLISHED", alternateLink: "https://classroom.google.com/c/x/a/y/details",
  creationTime: new Date().toISOString(), updateTime: new Date().toISOString(),
  dueDate: { year: tomorrow.getFullYear(), month: tomorrow.getMonth() + 1, day: tomorrow.getDate() },
};

async function openPlannerWithOneAssignment(context, { chatDelayMs = 0 } = {}) {
  const page = await context.newPage();
  let chatCalls = 0;
  await page.route("**/api/oauth-config*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasRefreshTokens: false }) }));
  await page.route("**/api/chat**", async (r) => {
    chatCalls++;
    if (chatDelayMs) await new Promise((res) => setTimeout(res, chatDelayMs));
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [] }) });
  });
  await page.route("**/api/**", (r) => r.fulfill({ status: 404, body: "{}" }));
  await page.route("**/accounts.google.com/**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("https://classroom.googleapis.com/**", (r) => {
    const url = r.request().url();
    const body = url.includes("/courseWork?") ? { courseWork: [WORK] }
      : url.includes("studentSubmissions") ? { studentSubmissions: [{ courseWorkId: "w1", state: "CREATED" }] }
      : url.includes("/courses?") ? { courses: [COURSE] }
      : {};
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => new Promise((res, rej) => {
    localStorage.setItem("cwa_user_hint", "student@example.edu");
    const req = indexedDB.open("cwa-archive", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("archive", { keyPath: "id" });
    req.onsuccess = () => {
      const tx = req.result.transaction("archive", "readwrite");
      tx.objectStore("archive").put({ id: "auth-session", token: "test-token", expiresAt: Date.now() + 3600000 });
      tx.oncomplete = () => { req.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    req.onerror = () => rej(req.error);
  }));
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector(".assignment", { timeout: 15000 });
  return { page, chatCalls: () => chatCalls };
}

try {
  // --- Phone: panel opens immediately, keyboard stays down ------------------
  const phone = await browser.newContext({ ...devices["iPhone 13"] });
  const { page } = await openPlannerWithOneAssignment(phone, { chatDelayMs: 1500 });

  const started = Date.now();
  await page.locator(".assignment").first().click();
  // Visible well before the deliberately slow /api/chat could have returned.
  await page.waitForSelector("#ai:not([hidden])", { timeout: 1000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1200, `panel took ${elapsed}ms to appear behind a 1500ms chat load — it is still waiting on it`);

  const focusedTag = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  assert.notEqual(focusedTag, "aiInput", "the question box must not be focused on a touch device — that raises the keyboard");

  // Opening a second time (history now cached) must behave identically.
  await page.locator("#aiClose").click();
  await page.locator(".assignment").first().click();
  await page.waitForSelector("#ai:not([hidden])", { timeout: 1000 });
  const focusedAgain = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  assert.notEqual(focusedAgain, "aiInput", "second open must not focus the input either — this is the 'every other time' case");
  await phone.close();

  // --- Desktop: a pointer user still gets the caret -------------------------
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const { page: dPage } = await openPlannerWithOneAssignment(desktop, { chatDelayMs: 1500 });
  const dStart = Date.now();
  await dPage.locator(".assignment").first().click();
  await dPage.waitForSelector("#ai:not([hidden])", { timeout: 1000 });
  assert.ok(Date.now() - dStart < 1200, "desktop panel should not wait on the chat load either");
  assert.equal(await dPage.evaluate(() => document.activeElement?.id), "aiInput",
    "a pointer user should still land in the question box");
  await desktop.close();

  // --- the card footer stays one row on a phone ----------------------------
  const phone2 = await browser.newContext({ ...devices["iPhone 13"] });
  const { page: cardPage } = await openPlannerWithOneAssignment(phone2);
  const footers = await cardPage.evaluate(() => [...document.querySelectorAll(".assignment")].map((card) => {
    const meta = card.querySelector(".meta");
    return {
      // Height is the measure, not the number of distinct child tops: the row
      // is `align-items: baseline`, so chips of different font sizes have
      // different box tops while sitting on the same line.
      metaHeight: Math.round(meta.getBoundingClientRect().height),
      overflows: meta.scrollWidth > meta.clientWidth + 1,
      actionsInCorner: getComputedStyle(card.querySelector(".card-actions")).position === "absolute",
      // Only the title line clears the corner buttons. Reserving that column on
      // the whole body cut the same third off the description and the footer,
      // which sit below the buttons with the full width available.
      titleLineWidth: (() => {
        const el = card.querySelector(".title-line");
        const cs = getComputedStyle(el);
        return Math.round(el.clientWidth - parseFloat(cs.paddingRight) - parseFloat(cs.paddingLeft));
      })(),
      bodyWidth: (() => {
        const el = card.querySelector(".assignment-body");
        const cs = getComputedStyle(el);
        return Math.round(el.clientWidth - parseFloat(cs.paddingRight) - parseFloat(cs.paddingLeft));
      })(),
      metaWidth: (() => {
        const cs = getComputedStyle(meta);
        return Math.round(meta.clientWidth - parseFloat(cs.paddingRight) - parseFloat(cs.paddingLeft));
      })(),
    };
  }));
  assert.ok(footers.length > 0, "expected at least one card");
  for (const f of footers) {
    // Two rows of chips is the reported defect; one line is ~19-24px.
    assert.ok(f.metaHeight <= 30, `card footer is ${f.metaHeight}px tall — it has wrapped to a second row`);
    assert.equal(f.overflows, false, "the footer must not spill out of the card");
    assert.equal(f.actionsInCorner, true, "the action buttons belong in the card's corner on a phone");
    assert.equal(f.metaWidth, f.bodyWidth, "the footer should have the card's full width — the buttons are above it");
    assert.ok(f.titleLineWidth < f.bodyWidth - 40,
      `the title line should clear the buttons (title ${f.titleLineWidth}px vs body ${f.bodyWidth}px)`);
  }
  await phone2.close();

  console.log(`✓ panel opens immediately on tap; no keyboard on touch, caret kept on desktop; card footer one row (${footers[0].metaHeight}px)`);
} finally {
  await browser.close();
}
