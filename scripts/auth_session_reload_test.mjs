// auth_session_reload_test.mjs — prove the browser-local Classroom session
// rehydrates across a full page reload without exposing the token in page storage.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const TOKEN = "browser-only-access-token-for-reload-test";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

await context.addInitScript(({ token }) => {
  window.google = {
    accounts: {
      oauth2: {
        initTokenClient(options) {
          const client = {
            callback: options.callback,
            requestAccessToken({ prompt } = {}) {
              window.__authReloadPrompts = [...(window.__authReloadPrompts || []), prompt];
              if (prompt === "") return;
              queueMicrotask(() => client.callback({ access_token: token, expires_in: 3600 }));
            },
          };
          return client;
        },
        initCodeClient() { return { requestCode() {} }; },
      },
    },
  };
}, { token: TOKEN });

await page.route("**/api/oauth-config", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ hasRefreshTokens: false }),
}));
await page.route("**/api/prefs**", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({}),
}));
await page.route("**/api/user**", (route) => route.fulfill({
  status: 404,
  contentType: "application/json",
  body: JSON.stringify({}),
}));
await page.route("https://www.googleapis.com/oauth2/v3/userinfo", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ sub: "reload-test-user", email: "student@example.edu", given_name: "Reload Student" }),
}));
await page.route("https://classroom.googleapis.com/**", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ courses: [] }),
}));

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  // Seed through the real module boundary, not a hand-written IndexedDB fixture.
  await page.evaluate(async (token) => {
    const { storeAuthSession } = await import("/auth-session.js");
    await storeAuthSession(token, 3600);
  }, TOKEN);
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("welcome")?.hidden === true, null, { timeout: 10000 });

  assert.equal(await page.locator("#menuWrap").evaluate((element) => element.hidden), false, "rehydrated session should restore the signed-in shell");
  assert.match(await page.locator("#userInfo").textContent(), /Signed in as Reload Student/);
  const storage = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
    token: window.__cwaAccessToken,
  }));
  assert.equal(storage.token, TOKEN, "rehydration should expose the token only through the in-memory window mirror");
  assert.equal(Object.values(storage.localStorage).some((value) => String(value).includes(TOKEN)), false, "localStorage must not contain the access token");
  assert.equal(Object.values(storage.sessionStorage).some((value) => String(value).includes(TOKEN)), false, "sessionStorage must not contain the access token");
  assert.equal(storage.localStorage.cwa_token_v9, undefined, "legacy access-token localStorage key must stay absent");
  assert.equal(storage.localStorage.cwa_kb_token, undefined, "legacy KB-token localStorage key must stay absent");
  assert.deepEqual(await page.evaluate(() => window.__authReloadPrompts || []), [], "rehydration should not require an interactive account prompt");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ IndexedDB auth session rehydrates across reload (${BASE})`);
} finally {
  await browser.close();
}
