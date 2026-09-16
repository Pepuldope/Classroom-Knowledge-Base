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

async function openPlannerWithOneAssignment(context, { chatDelayMs = 0, chatMessages = [] } = {}) {
  const page = await context.newPage();
  let chatCalls = 0;
  // Registration order matters and is COUNTER-INTUITIVE: Playwright matches
  // routes in reverse registration order, so the catch-all has to go FIRST or
  // it swallows every specific stub below it. It used to be last, which meant
  // /api/chat answered 404 and neither chatDelayMs nor chatMessages ever
  // reached the app.
  await page.route("**/api/**", (r) => r.fulfill({ status: 404, body: "{}" }));
  await page.route("**/api/oauth-config*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasRefreshTokens: false }) }));
  await page.route("**/api/chat**", async (r) => {
    chatCalls++;
    if (chatDelayMs) await new Promise((res) => setTimeout(res, chatDelayMs));
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: chatMessages }) });
  });
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

  // --- a saved conversation opens at the TOP, with a way back to the tail ---
  // Pepuldo, 2026-09-16: "When opening assignment with an ai history it should
  // start at the top of the scroll thingy so that you see the details of the
  // assignment first." addMsg used to scroll on every message it drew, so
  // re-rendering a saved history landed the reader at its end.
  const phone3 = await browser.newContext({ ...devices["iPhone 13"] });
  const history = [];
  for (let i = 0; i < 12; i++) {
    history.push({ role: "user", content: `Question number ${i} about the pitch deck, long enough to take a line or two on a phone.` });
    history.push({ role: "assistant", content: `Answer number ${i}. ${"Detail ".repeat(30)}` });
  }
  const { page: histPage, chatCalls: histChatCalls } = await openPlannerWithOneAssignment(phone3, { chatMessages: history });
  await histPage.locator(".assignment").first().click();
  await histPage.waitForSelector("#ai:not([hidden])", { timeout: 5000 });
  await histPage.waitForFunction(() => document.querySelectorAll("#aiMessages .ai-msg").length >= 24, null, { timeout: 5000 });
  assert.ok(histChatCalls() > 0, "the /api/chat stub was never reached — the route order regressed");

  const atOpen = await histPage.evaluate(() => {
    const el = document.getElementById("aiScroll");
    return {
      top: Math.round(el.scrollTop),
      scrollable: el.scrollHeight > el.clientHeight,
      jumpHidden: document.getElementById("aiJumpLatest")?.hidden,
      contextVisible: document.getElementById("aiContext").getBoundingClientRect().top >= el.getBoundingClientRect().top - 1,
    };
  });
  assert.equal(atOpen.scrollable, true, "24 messages did not make the sheet scrollable — the fixture is wrong, not the app");
  assert.equal(atOpen.top, 0, `a saved conversation opened ${atOpen.top}px down instead of at the assignment's details`);
  assert.equal(atOpen.contextVisible, true, "the assignment's own details are not on screen when it opens");
  assert.equal(atOpen.jumpHidden, false, "no way back to the latest message from the top of a long chat");

  await histPage.locator("#aiJumpLatest").click();
  const atBottom = await histPage.evaluate(() => {
    const el = document.getElementById("aiScroll");
    return { distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), jumpHidden: document.getElementById("aiJumpLatest")?.hidden };
  });
  assert.ok(atBottom.distance <= 2, `Latest left the reader ${atBottom.distance}px from the bottom`);
  assert.equal(atBottom.jumpHidden, true, "Latest is still offering to do what it just did");
  await phone3.close();
  console.log("✓ a saved conversation opens at the assignment's details, and Latest jumps to the tail");

  // --- the open assignment survives a trip to Study, and only a trip -------
  // Pepuldo, 2026-09-16: "When you click on an assignment, it should stay open
  // as a part of the study/planner page. When you go to other page while
  // having it out, it goes away but when coming back, it shows itself." The
  // same mechanism is why the material suggestions were unreachable on a
  // phone: the "From your notes" chips switch to Study, and the full-screen
  // sheet stayed on top of the note they opened.
  //
  // The route change is dispatched on the button itself rather than clicked at
  // its coordinates: on a phone the scrim deliberately covers the switcher, so
  // a positional tap is a dismissal by design. What is under test is what
  // setView does when a route change arrives with a panel open — which is the
  // path the in-sheet chips take.
  const switchTo = (page, view) => page.evaluate(
    (v) => document.querySelector(`.view-toggle-btn[data-view="${v}"]`).click(), view);

  const phone4 = await browser.newContext({ ...devices["iPhone 13"] });
  const { page: navPage } = await openPlannerWithOneAssignment(phone4);
  await navPage.locator(".assignment").first().click();
  await navPage.waitForSelector("#ai:not([hidden])", { timeout: 5000 });
  const title = await navPage.locator("#aiTitle").textContent();

  await switchTo(navPage, "kb");
  await navPage.waitForTimeout(300);
  const onStudy = await navPage.evaluate(() => ({
    sheetHidden: document.getElementById("ai").hidden,
    scrimHidden: document.getElementById("aiScrim").hidden,
    studyVisible: !document.getElementById("kbView").hidden,
    bodyLocked: getComputedStyle(document.body).position === "fixed",
  }));
  assert.equal(onStudy.studyVisible, true, "Study did not come up");
  assert.equal(onStudy.sheetHidden, true, "the sheet stayed over the Study page — this is the phone report");
  assert.equal(onStudy.scrimHidden, true, "the scrim stayed over the Study page");
  assert.equal(onStudy.bodyLocked, false, "the background scroll lock outlived the sheet");

  await switchTo(navPage, "planner");
  await navPage.waitForSelector("#ai:not([hidden])", { timeout: 5000 });
  assert.equal(await navPage.locator("#aiTitle").textContent(), title,
    "coming back to the Planner did not show the assignment again");

  // Closing it means closing it: that must not come back.
  await navPage.locator("#aiClose").click();
  await switchTo(navPage, "kb");
  await navPage.waitForTimeout(200);
  await switchTo(navPage, "planner");
  await navPage.waitForTimeout(400);
  assert.equal(await navPage.evaluate(() => document.getElementById("ai").hidden), true,
    "an assignment the reader closed came back on its own");
  await phone4.close();
  console.log("✓ an open assignment hides for Study and returns with the Planner; a closed one stays closed");

  console.log(`✓ panel opens immediately on tap; no keyboard on touch, caret kept on desktop; card footer one row (${footers[0].metaHeight}px)`);
} finally {
  await browser.close();
}
