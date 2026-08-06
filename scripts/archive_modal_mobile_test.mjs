// Verify the Archive note modal remains usable on a narrow screen during open/close.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const TOKEN = "browser-only-archive-modal-mobile-test-token";
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
await page.route("https://www.googleapis.com/oauth2/v3/userinfo", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sub: "archive-modal-user", email: "student@example.edu" }) }));
await page.route("https://classroom.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ courses: [] }) }));

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(async (token) => {
    const { storeAuthSession } = await import("/auth-session.js");
    await storeAuthSession(token, 3600);
    const { storeArchiveBundle } = await import("/archive.js");
    await storeArchiveBundle({
      version: 1,
      source: "classroom",
      generatedAt: new Date().toISOString(),
      years: ["2026"],
      courses: [{ name: "Mobile Mathematics", y: "2026", noteCount: 1 }],
      notes: [{ t: "A very long archive note title that should stay inside the phone viewport", course: "Mobile Mathematics", y: "2026", topic: "Algebra", s: "Summary", x: "A note body with a long URL https://example.com/a/very/long/path/that/must/wrap safely." }],
    });
  }, TOKEN);
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("welcome")?.hidden === true, null, { timeout: 10000 });
  await page.locator('.view-toggle-btn[data-view="archive"]').click({ force: true });
  await page.waitForSelector(".archive-note-row", { state: "attached", timeout: 10000 });
  await page.evaluate(() => document.querySelectorAll("#archiveMain details").forEach((detail) => { detail.open = true; }));
  const row = page.locator(".archive-note-row").first();
  await row.click();
  await page.waitForFunction(() => !document.getElementById("archiveNoteModal")?.hidden);
  const state = await page.evaluate(() => {
    const modal = document.getElementById("archiveNoteModal");
    const card = modal?.querySelector(".modal-card");
    const close = document.getElementById("archiveNoteClose");
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const rect = card?.getBoundingClientRect();
    const style = close ? getComputedStyle(close) : null;
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: viewport.width,
      cardWithinViewport: Boolean(rect && rect.left >= 0 && rect.right <= viewport.width && rect.top >= 0 && rect.bottom <= viewport.height),
      closeVisible: Boolean(close && rect && close.getBoundingClientRect().right <= viewport.width),
      closeFocusOutline: style?.outlineStyle || "none",
    };
  });
  assert.ok(state.pageScrollWidth <= state.viewportWidth + 1, `Archive modal must not create horizontal overflow: ${state.pageScrollWidth}px > ${state.viewportWidth}px`);
  assert.equal(state.cardWithinViewport, true, "Archive modal card must fit inside the narrow viewport");
  assert.equal(state.closeVisible, true, "Archive modal close control must remain visible on a narrow viewport");
  await page.locator("#archiveNoteClose").focus({ focusVisible: true });
  const focused = await page.evaluate(() => {
    const close = document.getElementById("archiveNoteClose");
    return { active: document.activeElement === close, outline: getComputedStyle(close).outlineStyle };
  });
  assert.equal(focused.active, true, "Archive modal close control must accept keyboard focus");
  assert.notEqual(focused.outline, "none", "Archive modal close control must expose a visible focus outline");
  await page.locator("#archiveNoteClose").click();
  await page.waitForFunction(() => document.getElementById("archiveNoteModal")?.hidden === true);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("archive-note-row")), true, "closing an Archive note modal must restore focus to its originating row");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ Archive modal remains focused and inside 390px viewport (${BASE})`);
} finally {
  await browser.close();
}
