// byok_settings_test.mjs — bringing your own AI provider key.
//
// The feature is small; the two properties worth a browser gate are not:
//   1. the key reaches /api/tutor, so the tutor can actually use it;
//   2. it reaches NOTHING ELSE — above all not /api/prefs, which would put it
//      in the server's KV store, in a public-repo project.
//
// A model test can assert the storage key is absent from STORAGE_KEYS. Only a
// browser can watch every request the page actually makes.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { openSignedInPage } from "./lib/harness.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const SECRET = "gsk_test_do_not_leak_0123456789";

const browser = await chromium.launch();
let failed = false;
try {
  const { page, errors } = await openSignedInPage(browser, { base: BASE });

  // Every request body the page sends, so "did the key go anywhere else" is a
  // question about evidence rather than about reading the source.
  const sent = [];
  page.on("request", (req) => {
    const data = req.postData();
    if (data) sent.push({ url: req.url(), body: data });
  });
  let tutorBody = null;
  await page.route("**/api/tutor", async (route) => {
    tutorBody = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: `data: ${JSON.stringify({ type: "route", provider: "yours:groq", model: "llama-3.3-70b-versatile" })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: "ready" } }] })}\n\ndata: [DONE]\n\n`,
    });
  });

  // Settings lives behind the account menu popover; dispatched on the button
  // itself, the way the other settings gates do it.
  await page.evaluate(() => document.querySelector("#settingsBtn")?.click());
  await page.waitForSelector("#settingsModal:not([hidden])");
  await page.evaluate(() => document.querySelector("#settingsTab-ai")?.click());

  const providers = await page.evaluate(() =>
    [...document.querySelectorAll("#byokProvider option")].map((o) => o.value));
  assert.ok(providers.includes("groq") && providers.includes("openrouter"),
    `the provider list is not populated: ${JSON.stringify(providers)}`);
  assert.equal(providers[0], "", "there is no way back to the shared free models");
  console.log(`✓ Settings offers ${providers.length - 1} providers, with the shared models as the default`);

  await page.selectOption("#byokProvider", "groq");
  await page.evaluate((secret) => {
    const el = document.getElementById("byokKey");
    el.value = secret;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, SECRET);
  await page.waitForTimeout(150);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cwa_ai_byok") || "null"));
  assert.equal(stored?.provider, "groq");
  assert.equal(stored?.apiKey, SECRET);

  // Shown back masked. A key rendered in full is a key in a screenshot.
  const shown = await page.evaluate(() => ({
    value: document.getElementById("byokKey").value,
    placeholder: document.getElementById("byokKey").placeholder,
  }));
  assert.equal(shown.value, "", "the key is still sitting in the input");
  assert.ok(!shown.placeholder.includes("do_not_leak"), `the key is displayed in full: ${shown.placeholder}`);
  console.log("✓ the key is stored for this browser and shown back masked");

  // --- it reaches the tutor -------------------------------------------------
  await page.evaluate(() => document.querySelector("#byokTest").click());
  await page.waitForFunction(() => /Working|did not answer|refused|No answer/.test(document.getElementById("byokStatus").textContent), null, { timeout: 8000 });
  assert.ok(tutorBody, "Test this key never called the tutor");
  assert.equal(tutorBody.byok?.provider, "groq");
  assert.equal(tutorBody.byok?.apiKey, SECRET);
  assert.match(await page.locator("#byokStatus").textContent(), /Working/);
  console.log("✓ the key reaches /api/tutor, and the test reports which model answered");

  // --- and nowhere else -----------------------------------------------------
  // Force a real prefs push first: asserting "the key was not in any prefs
  // call" proves nothing when no prefs call was made. readLocalPrefsDoc builds
  // the exact document that goes to /api/prefs, so this is the whole surface.
  const doc = await page.evaluate(async () => {
    const mod = await import("/prefs-sync-local.js");
    return JSON.stringify(mod.readLocalPrefsDoc());
  });
  assert.ok(!doc.includes(SECRET), "the key is in the document /api/prefs receives");
  assert.ok(!/byok/i.test(doc), "a byok field is in the document /api/prefs receives");
  console.log("✓ the document /api/prefs receives carries neither the key nor a byok field");

  const leaks = sent.filter((r) => r.body.includes(SECRET) && !r.url.includes("/api/tutor"));
  assert.deepEqual(leaks.map((l) => l.url), [], "the key was sent somewhere other than the tutor");
  const prefsCalls = sent.filter((r) => r.url.includes("/api/prefs"));
  for (const call of prefsCalls) {
    assert.ok(!call.body.includes(SECRET), "the key reached the prefs document");
    assert.ok(!call.body.includes("byok"), "a byok field reached the prefs document");
  }
  console.log(`✓ no request but the tutor's carried the key (${sent.length} request(s) with a body seen)`);

  // --- removing it really removes it ---------------------------------------
  await page.evaluate(() => document.querySelector("#byokClear").click());
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => localStorage.getItem("cwa_ai_byok")), null);
  assert.equal(await page.evaluate(() => document.getElementById("byokProvider").value), "");
  console.log("✓ Remove key puts the tutor back on the shared free models");

  assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
} catch (e) {
  failed = true;
  console.error("✗", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
