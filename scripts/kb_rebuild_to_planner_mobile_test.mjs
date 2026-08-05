// Verify switching from the local KB rebuild prompt to Planner clears KB modal state.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { summarizeWarmTransitionSamples } from "../kb-transition-timing.js";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const TOKEN = "browser-only-access-token-for-kb-modal-switch-test";
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
              window.__kbModalSwitchPrompts = [...(window.__kbModalSwitchPrompts || []), prompt];
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
  body: JSON.stringify({ sub: "kb-modal-switch-user", email: "student@example.edu", given_name: "KB Student" }),
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
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await page.waitForFunction(() => !document.getElementById("kbView")?.hidden);
  await page.evaluate(() => {
    const kb = document.getElementById("kbView");
    const onboarding = document.getElementById("kbOnboarding");
    const noteModal = document.getElementById("kbNoteModal");
    const tutorModal = document.getElementById("kbTutorModal");
    if (!kb || !onboarding || !noteModal || !tutorModal) throw new Error("KB rebuild surface is missing");
    kb.hidden = false;
    onboarding.hidden = false;
    noteModal.hidden = false;
    tutorModal.hidden = false;
  });

  const transitionSamples = [];
  for (let sample = 0; sample < 3; sample += 1) {
    // The open modal intentionally covers the mobile header, so dispatch the
    // real DOM click handler to model the route transition without bypassing
    // app logic. Measure entirely in-page to avoid Playwright round-trip time.
    const elapsed = await page.evaluate(() => {
      const planner = document.querySelector('.view-toggle-btn[data-view="planner"]');
      if (!planner) throw new Error("Planner navigation control is missing");
      const started = performance.now();
      planner.click();
      return new Promise((resolve, reject) => {
        const deadline = started + 1000;
        const check = () => {
          const plannerView = document.getElementById("plannerView");
          const noteModal = document.getElementById("kbNoteModal");
          const tutorModal = document.getElementById("kbTutorModal");
          const plannerActive = document.activeElement?.matches('.view-toggle-btn[data-view="planner"]');
          if (!plannerView?.hidden && noteModal?.hidden && tutorModal?.hidden && plannerActive) {
            resolve(performance.now() - started);
          } else if (performance.now() >= deadline) {
            reject(new Error("KB-to-Planner transition did not settle within 1s"));
          } else {
            requestAnimationFrame(check);
          }
        };
        requestAnimationFrame(check);
      });
    });
    transitionSamples.push(elapsed);
    assert.equal(await page.locator("#kbNoteModal").isHidden(), true, "note modal must close when leaving KB");
    assert.equal(await page.locator("#kbTutorModal").isHidden(), true, "tutor modal must close when leaving KB");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.view), "planner", "Planner navigation control must regain focus after KB modal closes");
    if (sample < 2) {
      await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
      await page.waitForFunction(() => !document.getElementById("kbView")?.hidden);
      await page.evaluate(() => {
        document.getElementById("kbOnboarding").hidden = false;
        document.getElementById("kbNoteModal").hidden = false;
        document.getElementById("kbTutorModal").hidden = false;
      });
    }
  }
  const timing = summarizeWarmTransitionSamples(transitionSamples);
  assert.equal(timing.withinBudget, true, `warm KB-to-Planner transition exceeded 100ms p95: ${JSON.stringify(timing)}`);
  assert.deepEqual(await page.evaluate(() => window.__kbModalSwitchPrompts || []), [], "switching views must not trigger interactive account prompts");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ mobile KB rebuild prompt returns cleanly to Planner (p95 ${timing.p95Ms.toFixed(2)}ms, ${BASE})`);
} finally {
  await browser.close();
}
