// Verify resumed local Classroom checkpoints are token-free at the IndexedDB seam
// and keep the rebuild card hidden until the checkpoint is genuinely empty.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(async () => {
    const local = await import("/kb-local.js");
    await local.removeKbBundle();
    await local.saveKbBuildCheckpoint({
      courses: [{ id: "c1", name: "Algebra" }, { id: "c2", name: "Physics" }],
      courseData: {
        c1: {
          headers: { Authorization: "Bearer browser-secret" },
          request: { access_token: "browser-secret", refreshToken: "browser-secret", keep: "safe" },
          courseWork: [{ id: "a1", title: "Private assignment" }],
        },
      },
    });
  });

  const checkpoint = await page.evaluate(async () => {
    const local = await import("/kb-local.js");
    return local.loadKbBuildCheckpoint();
  });
  const serialized = JSON.stringify(checkpoint).toLowerCase();
  assert.equal(serialized.includes("browser-secret"), false, "checkpoint must not persist token values");
  assert.equal(serialized.includes("authorization"), false, "checkpoint must not persist authorization headers");
  assert.equal(serialized.includes("access_token"), false, "checkpoint must not persist access-token fields");
  assert.equal(serialized.includes("refreshtoken"), false, "checkpoint must not persist refresh-token fields");

  await page.evaluate(async () => {
    const kb = await import("/kb.js");
    kb.showKbView();
  });
  await page.waitForSelector("#kbView:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById("kbMetaBar")?.textContent.includes("Loading your knowledge base") || document.getElementById("kbResumeBuildBtn")?.hidden === false, null, { timeout: 10000 });
  assert.equal(await page.locator("#kbOnboarding").isHidden(), true, "resumed build must keep rebuild card hidden");
  assert.equal(await page.locator("#kbMain").isHidden(), false, "resumed build must keep study surface visible");
  assert.equal(await page.locator("#kbResumeBuildBtn").isHidden(), false, "resumed build must expose resume action");

  await page.evaluate(async () => {
    const local = await import("/kb-local.js");
    await local.removeKbBuildCheckpoint();
    const kb = await import("/kb.js");
    await kb.refreshKb();
  });
  await page.waitForFunction(() => document.getElementById("kbOnboarding")?.hidden === false, null, { timeout: 10000 });
  assert.equal(await page.locator("#kbBuildPanel").isHidden(), true, "true empty state must hide stale build panel");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✓ checkpoint browser privacy and resume surface (${BASE})`);
} finally {
  await page.evaluate(async () => {
    const local = await import("/kb-local.js");
    await local.removeKbBuildCheckpoint();
    await local.removeKbBundle();
  }).catch(() => {});
  await browser.close();
}
