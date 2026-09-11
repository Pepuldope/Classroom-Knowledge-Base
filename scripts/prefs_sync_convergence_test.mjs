// prefs_sync_convergence_test.mjs — two devices, one account, no lost work.
//
// The unit tests in tests/prefs-sync.test.js pin the merge rules. This pins the
// thing they cannot: that the rules survive the round trip. localStorage ->
// readLocalPrefsDoc -> POST -> the server's merge -> applySyncedPrefs ->
// localStorage, in two real browser contexts that share nothing but the store.
//
// Two contexts rather than two tabs on purpose: separate origins-with-storage
// is what a phone and a laptop actually are, and a same-tab test would pass on
// shared module state that does not exist between devices.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mergeSyncedPrefs } from "../prefs-sync.js";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const failures = [];

// The "server": one KV value, and the same merge api/prefs.js performs.
let store = {};
let writes = 0;

async function device(name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  // Registered BEFORE the specific route below: Playwright tries handlers in
  // reverse registration order, so the catch-all has to go first or it answers
  // /api/prefs with a 404 and the gate silently tests nothing.
  await page.route("**/api/**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  await page.route("**/api/prefs**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      writes++;
      const body = JSON.parse(request.postData() || "{}");
      store = mergeSyncedPrefs(body.prefs, store);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, prefs: store }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ prefs: store }) });
  });
  await page.route("**/accounts.google.com/**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  return { context, page, errors };
}

/** Run one sync exactly as the app does: push this device, adopt the merge. */
const sync = (page) => page.evaluate(async () => {
  const { readLocalPrefsDoc, applySyncedPrefs } = await import("/prefs-sync-local.js");
  const r = await fetch("/api/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefs: readLocalPrefsDoc() }),
  });
  const data = await r.json();
  applySyncedPrefs(data.prefs);
  return data.prefs;
});

const setLocal = (page, entries) => page.evaluate((pairs) => {
  for (const [k, v] of pairs) localStorage.setItem(k, JSON.stringify(v));
}, entries);

const getLocal = (page, key) => page.evaluate((k) => {
  try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; }
}, key);

function check(name, fn) {
  return fn().then(
    () => console.log(`  ✓ ${name}`),
    (e) => { failures.push(`${name}: ${e.message}`); console.log(`  ✗ ${name}: ${e.message}`); },
  );
}

console.log("[prefs sync convergence]");

const phone = await device("phone");
const laptop = await device("laptop");

await check("each device's pins and streak reach the other", () =>
  (async () => {
    await setLocal(phone.page, [
      ["cwa_pinned", ["assignment-1"]],
      ["cwa_kb_study_activity", ["2026-09-10"]],
      ["cwa_kb_note_progress", { "math/algebra.md": { opened: 3, lastOpened: "2026-09-10" } }],
    ]);
    await sync(phone.page);

    await setLocal(laptop.page, [
      ["cwa_pinned", ["assignment-2"]],
      ["cwa_kb_study_activity", ["2026-09-11"]],
      ["cwa_kb_note_progress", { "math/algebra.md": { opened: 1, lastOpened: "2026-09-11" } }],
    ]);
    await sync(laptop.page);

    assert.deepEqual((await getLocal(laptop.page, "cwa_pinned")).sort(), ["assignment-1", "assignment-2"]);
    assert.deepEqual(await getLocal(laptop.page, "cwa_kb_study_activity"), ["2026-09-10", "2026-09-11"]);
    // The count the phone had, the date the laptop had — neither device's work lost.
    assert.deepEqual(await getLocal(laptop.page, "cwa_kb_note_progress"),
      { "math/algebra.md": { opened: 3, lastOpened: "2026-09-11" } });

    // And the phone converges on the same thing when it next syncs.
    await sync(phone.page);
    assert.deepEqual((await getLocal(phone.page, "cwa_pinned")).sort(), ["assignment-1", "assignment-2"]);
    assert.deepEqual(await getLocal(phone.page, "cwa_kb_study_activity"), ["2026-09-10", "2026-09-11"]);
  })());

await check("unpinning on one device is not undone by the other", () =>
  (async () => {
    // THE failure a naive union sync ships with. The laptop unpins; the phone
    // still has it locally and syncs afterwards.
    await setLocal(laptop.page, [["cwa_pinned", ["assignment-2"]]]);
    await sync(laptop.page);
    assert.deepEqual(await getLocal(laptop.page, "cwa_pinned"), ["assignment-2"]);

    await sync(phone.page);
    assert.deepEqual(await getLocal(phone.page, "cwa_pinned"), ["assignment-2"],
      "assignment-1 rose from the dead");
  })());

await check("a re-pin after a delete sticks", () =>
  (async () => {
    const before = await getLocal(phone.page, "cwa_pinned");
    await setLocal(phone.page, [["cwa_pinned", [...before, "assignment-1"]]]);
    await sync(phone.page);
    await sync(laptop.page);
    assert.ok((await getLocal(laptop.page, "cwa_pinned")).includes("assignment-1"));
  })());

await check("pinned notes and the study list carry their content across", () =>
  (async () => {
    await setLocal(phone.page, [
      ["cwa_kb_pinned_notes", [{ id: "n1", title: "Quadratic equations" }]],
      ["cwa_tutor_study_list", [{ id: "q1", text: "Why is the sky blue?", savedAt: 1757577600000 }]],
    ]);
    await sync(phone.page);
    await sync(laptop.page);
    assert.deepEqual(await getLocal(laptop.page, "cwa_kb_pinned_notes"),
      [{ id: "n1", title: "Quadratic equations" }]);
    assert.deepEqual(await getLocal(laptop.page, "cwa_tutor_study_list"),
      [{ id: "q1", text: "Why is the sky blue?", savedAt: 1757577600000 }]);
  })());

await check("tutor settings follow the account to the other device", () =>
  (async () => {
    await setLocal(laptop.page, [["cwa_kb_settings", { tutorEnabled: true, tutorEffort: "hard", density: "compact" }]]);
    await sync(laptop.page);
    await sync(phone.page);
    const settings = await getLocal(phone.page, "cwa_kb_settings");
    assert.equal(settings.tutorEffort, "hard");
    assert.equal(settings.density, "compact");
  })());

await check("syncing again with nothing changed is a no-op", () =>
  (async () => {
    const before = await sync(phone.page);
    const again = await sync(phone.page);
    assert.deepEqual(again, before, "a quiet sync still moved the document");
    const third = await sync(laptop.page);
    assert.deepEqual(third.studyActivity, before.studyActivity);
  })());

await check("kb.js can reach the debounced push without importing app.js", () =>
  (async () => {
    // kb.js calls window.__cwaPushPrefs. If app.js ever stops publishing it,
    // every Study-side change stops syncing silently — no error, no symptom
    // until someone notices their streak did not follow them.
    const published = await phone.page.evaluate(() => typeof window.__cwaPushPrefs);
    assert.equal(published, "function", "app.js no longer publishes __cwaPushPrefs");
  })());

for (const d of [phone, laptop]) {
  assert.deepEqual(d.errors, [], `page errors: ${d.errors.join("; ")}`);
  await d.context.close();
}
await browser.close();

console.log(`  (${writes} writes to the store)`);
if (failures.length) {
  console.error(`[prefs sync convergence] ${failures.length} failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[prefs sync convergence] 7/7 passed");
