// Verify KB modal transitions restore a visibly marked focus target in Planner and Archive.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const TEST_ACCESS = "browser-only-focus-transition-test-token";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

await context.addInitScript(({ token }) => {
  window.google = { accounts: { oauth2: {
    initTokenClient(options) {
      const client = { callback: options.callback, requestAccessToken({ prompt } = {}) {
        if (prompt === "") return;
        queueMicrotask(() => client.callback({ access_token: token, expires_in: 3600 }));
      } };
      return client;
    },
    initCodeClient() { return { requestCode() {} }; },
  } } };
}, { token: TEST_ACCESS });
await page.route("**/api/oauth-config", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasRefreshTokens: false }) }));
await page.route("**/api/prefs**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }));
await page.route("**/api/user**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({}) }));
await page.route("https://www.googleapis.com/oauth2/v3/userinfo", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sub: "focus-user", email: "student@example.edu" }) }));
await page.route("https://classroom.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ courses: [] }) }));

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(async (token) => {
    const { storeAuthSession } = await import("/auth-session.js");
    await storeAuthSession(token, 3600);
  }, TEST_ACCESS);
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("welcome")?.hidden === true, null, { timeout: 10000 });
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await page.waitForFunction(() => !document.getElementById("kbView")?.hidden);
  const storageBeforeTransition = await page.evaluate(() => Object.entries(localStorage));

  for (const target of ["planner", "archive"]) {
    await page.evaluate(() => {
      document.getElementById("kbNoteModal").hidden = false;
      document.getElementById("kbTutorModal").hidden = false;
    });
    await page.evaluate((view) => document.querySelector(`.view-toggle-btn[data-view="${view}"]`)?.click(), target);
    await page.waitForFunction(() => document.getElementById("kbNoteModal")?.hidden && document.getElementById("kbTutorModal")?.hidden, null, { timeout: 3000 });
    await page.waitForFunction((view) => document.activeElement === document.querySelector(`.view-toggle-btn[data-view="${view}"]`), target, { timeout: 3000 });
    const state = await page.locator(`.view-toggle-btn[data-view="${target}"]`).evaluate((button) => ({
      focused: document.activeElement === button,
      marked: button.classList.contains("view-toggle-focus-restored"),
      outline: getComputedStyle(button).outlineStyle,
    }));
    assert.equal(state.focused, true, `${target} navigation must regain focus`);
    assert.equal(state.marked, true, `${target} navigation focus must be visibly marked after a KB modal transition`);
    assert.notEqual(state.outline, "none", `${target} navigation focus must expose a visible outline`);
    const storageAfterTransition = await page.evaluate(() => Object.entries(localStorage));
    assert.deepEqual(storageAfterTransition, storageBeforeTransition, `${target} route transition must not write focus markers to localStorage`);
    assert.equal(JSON.stringify(storageAfterTransition).includes("Focus restored"), false, `${target} localStorage must not contain route-transition marker text`);
    if (target === "planner") {
      await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
      await page.waitForFunction(() => !document.getElementById("kbView")?.hidden);
    }
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ KB modal transitions visibly restore Planner and Archive focus (${BASE})`);
} finally {
  await browser.close();
}
