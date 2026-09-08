// mobile_session_resume_test.mjs — coming back to the site must not bounce you
// to the sign-in screen.
//
// The reported symptom, on a phone: return to the site and it asks you to sign
// in and "kind of does not work"; reload and you are signed straight back in as
// if nothing happened.
//
// Cause: gFetch's 401 recovery called ONLY GIS silent auth, while boot tried
// the server refresh (the httpOnly refresh cookie) FIRST. GIS silent auth is
// exactly what fails on a phone, so the 401 path gave up and cleared the
// session — while a reload took the boot path and succeeded. This test drives
// the 401 path and asserts the refresh cookie route is used.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

try {
  let refreshCalls = 0;
  let classroomCalls = 0;

  await page.route("**/api/oauth-config*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasRefreshTokens: true, clientId: "test" }) }));
  await page.route("**/api/oauth-refresh", (route) => {
    refreshCalls++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }) });
  });
  // The stored token is stale: Classroom rejects it, and accepts the fresh one.
  await page.route("https://classroom.googleapis.com/**", (route) => {
    classroomCalls++;
    const auth = route.request().headers()["authorization"] || "";
    if (auth.includes("fresh-token")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ courses: [] }) });
    }
    return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: 401 } }) });
  });
  // The Google Identity script never arrives — the everyday phone case this
  // test is about. Nothing stubs `window.google` in its place: the restore must
  // work without it.
  await page.route("**/accounts.google.com/**", (route) => route.fulfill({ status: 204, body: "" }));

  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Seed the state a returning signed-in user has: a stale access token in
  // IndexedDB, and the flags saying a server refresh cookie exists.
  await page.evaluate(() => {
    localStorage.setItem("cwa_has_server_session", "1");
    localStorage.setItem("cwa_user_hint", "student@example.com");
    return new Promise((res, rej) => {
      const req = indexedDB.open("cwa-archive", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("archive", { keyPath: "id" });
      req.onsuccess = () => {
        const tx = req.result.transaction("archive", "readwrite");
        tx.objectStore("archive").put({ id: "auth-session", token: "stale-token", expiresAt: Date.now() + 30 * 60000 });
        tx.oncomplete = () => { req.result.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
      req.onerror = () => rej(req.error);
    });
  });
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2500);
  if (process.env.DEBUG_RESUME) {
    console.log("DEBUG", JSON.stringify(await page.evaluate(() => ({
      welcomeHidden: document.getElementById("welcome")?.hidden,
      status: document.getElementById("status")?.textContent,
      reportHidden: document.getElementById("report")?.hidden,
      hasHint: localStorage.getItem("cwa_user_hint"),
      hasServer: localStorage.getItem("cwa_has_server_session"),
    })), null, 1));
  }

  assert.ok(classroomCalls > 0, "the app should have called Classroom with the stored token");
  assert.ok(refreshCalls > 0,
    `the 401 recovery must try the server refresh cookie (/api/oauth-refresh called ${refreshCalls} times)`);

  // And having recovered, it must not be sitting on the sign-in screen.
  const welcomeVisible = await page.evaluate(() => {
    const w = document.getElementById("welcome");
    return !!w && !w.hidden && w.getBoundingClientRect().height > 0;
  });
  assert.equal(welcomeVisible, false, "recovered session should not leave the user on the sign-in screen");

  console.log(`✓ 401 recovery used the refresh cookie (${refreshCalls} call(s)) and stayed signed in`);
} finally {
  await browser.close();
}
