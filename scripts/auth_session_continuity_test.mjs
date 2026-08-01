// auth_session_continuity_test.mjs — prove Planner, Archive, and KB use the
// same browser-local auth session and that sign-out clears that shared record.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const TOKEN = "browser-only-continuity-token";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
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
              window.__continuityPrompts = [...(window.__continuityPrompts || []), prompt];
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
  body: JSON.stringify({ sub: "continuity-user", email: "student@example.edu", given_name: "Continuity Student" }),
}));
await page.route("https://classroom.googleapis.com/**", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ courses: [] }),
}));

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(async (token) => {
    const { storeAuthSession } = await import("/auth-session.js");
    await storeAuthSession(token, 3600);
  }, TOKEN);
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("welcome")?.hidden === true, null, { timeout: 10000 });

  for (const view of ["planner", "archive", "kb"]) {
    await page.locator(`.view-toggle-btn[data-view="${view}"]`).click();
    await page.waitForFunction((name) => {
      const section = document.getElementById(`${name}View`);
      return section && !section.hidden;
    }, view);
    const state = await page.evaluate(async () => {
      const { loadStoredAuthSession } = await import("/auth-session.js");
      return { token: window.__cwaAccessToken, stored: await loadStoredAuthSession() };
    });
    assert.equal(state.token, TOKEN, `${view} should use the shared in-memory token`);
    assert.equal(state.stored.token, TOKEN, `${view} should converge on the shared IndexedDB auth record`);
  }

  await page.locator("#menuBtn").click();
  await page.locator("#logoutBtn").click();
  await page.waitForFunction(() => document.getElementById("welcome")?.hidden === false, null, { timeout: 10000 });
  const afterSignOut = await page.evaluate(async () => {
    const { loadStoredAuthSession } = await import("/auth-session.js");
    return { token: window.__cwaAccessToken, stored: await loadStoredAuthSession() };
  });
  assert.equal(afterSignOut.token, null, "sign-out should clear the shared in-memory token");
  assert.equal(afterSignOut.stored, null, "sign-out should clear the shared IndexedDB auth record");
  assert.deepEqual(await page.evaluate(() => window.__continuityPrompts || []), [], "rehydration/navigation should not prompt for an account");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ auth session converges across Planner, Archive, KB, and sign-out (${BASE})`);
} finally {
  await browser.close();
}
