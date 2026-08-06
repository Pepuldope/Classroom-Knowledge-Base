// Verify the persistent route-transition focus hint remains readable on narrow
// screens in both explicit themes.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const TOKEN = "browser-only-route-transition-mobile-test-token";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
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
}, { token: TOKEN });
await page.route("**/api/oauth-config", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasRefreshTokens: false }) }));
await page.route("**/api/prefs**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }));
await page.route("**/api/user**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({}) }));
await page.route("https://www.googleapis.com/oauth2/v3/userinfo", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sub: "route-mobile-user", email: "student@example.edu" }) }));
await page.route("https://classroom.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ courses: [] }) }));

function contrastRatio(foreground, background) {
  const luminance = (value) => {
    const channels = String(value).match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
    return channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  };
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(async (token) => {
    const { storeAuthSession } = await import("/auth-session.js");
    await storeAuthSession(token, 3600);
  }, TOKEN);
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("welcome")?.hidden === true, null, { timeout: 10000 });
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await page.waitForFunction(() => !document.getElementById("kbView")?.hidden, null, { timeout: 10000 });

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      document.getElementById("kbNoteModal").hidden = false;
    }, theme);
    await page.evaluate(() => document.querySelector('.view-toggle-btn[data-view="planner"]')?.click());
    const hint = page.locator("#routeTransitionFocusStatus");
    await page.waitForFunction(() => document.getElementById("routeTransitionFocusStatus")?.textContent.includes("Focus restored"), null, { timeout: 3000 }).catch(async (error) => {
      throw new Error(`${error.message}; state=${JSON.stringify(await page.evaluate(() => ({ status: document.getElementById("routeTransitionFocusStatus")?.textContent, current: [...document.querySelectorAll(".view-toggle-btn")].find((button) => button.classList.contains("active"))?.dataset.view, kbHidden: document.getElementById("kbView")?.hidden, plannerHidden: document.getElementById("plannerView")?.hidden, modalHidden: document.getElementById("kbNoteModal")?.hidden })))}`);
    });
    const state = await hint.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      let parent = element;
      let background = "rgba(0, 0, 0, 0)";
      while (parent) {
        const candidate = getComputedStyle(parent).backgroundColor;
        if (candidate !== "rgba(0, 0, 0, 0)" && candidate !== "transparent") { background = candidate; break; }
        parent = parent.parentElement;
      }
      return {
        text: element.textContent,
        width: rect.width,
        height: rect.height,
        color: style.color,
        background,
        whiteSpace: style.whiteSpace,
        maxWidth: style.maxWidth,
        overflowWrap: style.overflowWrap,
        right: rect.right,
      };
    });
    assert.ok(state.text.includes("Planner view opened"), `${theme}: hint should announce the destination`);
    assert.ok(state.width > 0 && state.height > 0, `${theme}: hint should have a visible box`);
    assert.ok(state.right <= 390 + 1, `${theme}: hint should fit the narrow viewport`);
    assert.equal(state.whiteSpace, "normal", `${theme}: hint should wrap on narrow screens`);
    assert.notEqual(state.maxWidth, "none", `${theme}: hint should have a bounded inline width`);
    assert.equal(state.overflowWrap, "anywhere", `${theme}: hint should break long words safely`);
    assert.ok(contrastRatio(state.color, state.background) >= 4.5, `${theme}: hint contrast must meet WCAG AA`);
    await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
    await page.waitForFunction(() => !document.getElementById("kbView")?.hidden, null, { timeout: 3000 });
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ route-transition focus hint is readable in light/dark themes at 390px (${BASE})`);
} finally {
  await browser.close();
}
