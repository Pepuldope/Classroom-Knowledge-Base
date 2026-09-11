// auth_restore_flash_test.mjs — a returning student must never be shown the
// sign-in card.
//
// The failure this pins is not an error, which is why it survived so long: the
// app worked perfectly, it just looked for a moment as though the student had
// been logged out. #welcome ships visible in the HTML and app.js can only hide
// it after the module graph loads, IndexedDB answers and, on a cold start,
// /api/oauth-refresh returns. On a phone that is comfortably a second of
// "Sign in with Google" in front of someone who never signed out.
//
// The gate holds a slow /api/oauth-refresh open on purpose. That is the worst
// case made deterministic: while the session is genuinely still in flight, the
// sign-in card must not be on screen. Timing this against a fast refresh would
// be a race, and a race that passes by accident is worse than no gate.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mockBackend } from "./lib/harness.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const failures = [];

/** Is the element actually being painted, whatever mechanism hides it? */
const shown = (page, id) => page.evaluate((elId) => {
  const el = document.getElementById(elId);
  if (!el) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}, id);

async function withPage(fn, { storage = null } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (storage) {
    await context.addInitScript((entries) => {
      try { for (const [k, v] of entries) localStorage.setItem(k, v); } catch {}
    }, storage);
  }
  try {
    await mockBackend(page, { courses: [] });
    await fn(page, context);
    assert.deepEqual(errors, [], "page errors");
  } finally {
    await context.close();
  }
}

function check(name, fn) {
  return fn().then(
    () => console.log(`  ✓ ${name}`),
    (e) => { failures.push(`${name}: ${e.message}`); console.log(`  ✗ ${name}: ${e.message}`); },
  );
}

console.log("[auth restore flash]");

// 1. The flash itself: a browser that has signed in before, with the refresh
//    still in flight, must be showing the resuming card and not the login card.
await check("a returning browser paints the resuming card, never the sign-in card", () =>
  withPage(async (page) => {
    let releaseRefresh;
    const held = new Promise((r) => { releaseRefresh = r; });
    let refreshRequests = 0;
    await page.route("**/api/oauth-config*", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasRefreshTokens: true }) }));
    await page.route("**/api/oauth-refresh", async (r) => {
      refreshRequests++;
      await held;
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access_token: "restored-token", expires_in: 3600 }),
      });
    });

    // domcontentloaded, not networkidle: the assertion is about the first
    // paint, and networkidle would wait for the very request being held.
    await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => document.getElementById("resuming") !== null, null, { timeout: 10000 });

    assert.equal(await shown(page, "welcome"), false, "sign-in card was painted to a returning user");
    assert.equal(await shown(page, "resuming"), true, "resuming card was not painted");
    assert.equal(await page.getAttribute("html", "data-restoring"), "1");

    // The inline boot script started the refresh; app.js must adopt that
    // request rather than issuing a second one.
    assert.equal(refreshRequests, 1, `expected one /api/oauth-refresh, saw ${refreshRequests}`);

    releaseRefresh();
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-restoring"),
      null, { timeout: 15000 });
    assert.equal(await shown(page, "resuming"), false, "resuming card outlived the restore");
    assert.equal(await shown(page, "welcome"), false, "sign-in card returned after a successful restore");
  }, { storage: [["cwa_has_server_session", "1"], ["cwa_user_hint", "student@example.edu"]] }));

// 2. A first-time visitor is the case the flash was protecting. They must still
//    get the sign-in card immediately — no spinner, no guessing.
await check("a first-time visitor still gets the sign-in card at once", () =>
  withPage(async (page) => {
    await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => document.getElementById("welcome") !== null, null, { timeout: 10000 });
    assert.equal(await page.getAttribute("html", "data-restoring"), null);
    assert.equal(await shown(page, "welcome"), true, "sign-in card was hidden from a new visitor");
    assert.equal(await shown(page, "resuming"), false, "a new visitor was told they were being signed back in");
  }));

// 3. The guess is a guess. A browser carrying the flags whose session is
//    actually dead must land on the sign-in card, not spin forever.
await check("a dead session falls back to the sign-in card", () =>
  withPage(async (page) => {
    await page.route("**/api/oauth-config*", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasRefreshTokens: true }) }));
    await page.route("**/api/oauth-refresh", (r) =>
      r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "refresh_invalid" }) }));

    await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-restoring"),
      null, { timeout: 15000 });
    assert.equal(await shown(page, "welcome"), true, "a dead session never reached the sign-in card");
    assert.equal(await shown(page, "resuming"), false, "the resuming card was left on screen");
  }, { storage: [["cwa_has_server_session", "1"]] }));

await browser.close();

if (failures.length) {
  console.error(`[auth restore flash] ${failures.length} failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[auth restore flash] 3/3 passed");
