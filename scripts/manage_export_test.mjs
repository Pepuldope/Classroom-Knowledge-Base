// manage_export_test.mjs — Manage → Export, end to end in a real browser.
//
// WHAT THIS GUARDS
//   1. The rebuild button reports WHERE IT WAS CLICKED. Its progress used to go
//      into #kbBuildPanel, which sits above the Study tab row — from Manage,
//      that is off-screen, so the button read as dead even while it worked.
//   2. A build that finds nothing new says "already up to date" rather than a
//      note total, which read as "there is still more to fetch".
//   3. The class picker offers the classes that exist, "Select shown" ticks
//      only what the search box is showing, and narrowing by year/type
//      actually narrows the row counts AND what a download would contain.
//   4. A ZIP export is a real archive with one file per assignment / material.
//      The Drive grant is folded into Download itself — no separate button —
//      and pulls attachments in when asked, reporting rather than failing on
//      a file the teacher never shared.
//   5. "Only what's new": a second Download of an already-exported class needs
//      no picker at all and says "All caught up"; adding a note offers only
//      what changed.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/manage_export_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openSignedInPage, seedKb } from "./lib/harness.mjs";

const note = (over) => ({
  p: `${over.y}/${over.course}/${over.t}`.replace(/\s+/g, "-"),
  topic: "Algebra",
  s: `${over.t} — summary`,
  x: "",
  ...over,
});

const BUNDLE = {
  version: 1,
  source: "classroom",
  generatedAt: new Date().toISOString(),
  years: ["2023-24", "2024-25"],
  courses: [{ name: "Matematika" }, { name: "Dejepis" }],
  clusters: [],
  notes: [
    note({
      t: "Quadratics worksheet",
      course: "Matematika",
      y: "2024-25",
      kind: "assignment",
      x: "Do every question.\n\nTeacher materials:\n- [Worksheet](https://drive.google.com/file/d/FILE_ONE_ID_X/view)\n\nDue: 2025-03-04",
    }),
    note({
      t: "Formula sheet",
      course: "Matematika",
      y: "2024-25",
      kind: "material",
      x: "Teacher materials:\n- [Formulas](https://docs.google.com/document/d/DOC_TWO_ID_X/edit)",
    }),
    note({ t: "Old logarithms test", course: "Matematika", y: "2023-24", kind: "assignment", x: "Max points: 20" }),
    note({ t: "SNP reading", course: "Dejepis", y: "2024-25", kind: "material", topic: "SNP", x: "Read chapter 4." }),
  ],
};

const browser = await chromium.launch();
let page;
let errors;

try {
  // No courses: the build runs, succeeds, and finds nothing — the exact case
  // that used to end on a note total Peter read as "there is more to update".
  ({ page, errors } = await openSignedInPage(browser, { courses: [] }));

  // Drive, mocked: one shared file, and one the teacher never shared (403).
  await page.route("https://www.googleapis.com/drive/v3/files/**", async (route) => {
    const url = route.request().url();
    if (url.includes("DOC_TWO_ID_X")) return route.fulfill({ status: 403, body: "forbidden" });
    if (url.includes("alt=media")) {
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 fake" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "FILE_ONE_ID_X", name: "Worksheet.pdf", mimeType: "application/pdf" }),
    });
  });

  // Registered after the harness's stub, so it wins (Playwright matches routes
  // in reverse registration order) — the server DOES have a picker key.
  await page.route("**/api/oauth-config*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ hasRefreshTokens: false, refreshTokensHealthy: false, pickerApiKey: "served-picker-key" }),
  }));

  await seedKb(page, BUNDLE);
  await page.evaluate(async () => {
    const kb = await import("/kb.js");
    document.getElementById("kbView").hidden = false;
    document.getElementById("plannerView").hidden = true;
    await kb.showKbView();
    // Stand in for the GIS Drive consent popup, which cannot run headless.
    window.__cwaRequestDriveToken = () => Promise.resolve("fake-drive-token");
    // Deliberately NOT set. This reproduces the bug Peter hit: a tab whose
    // sessionStorage cached /api/oauth-config from before GOOGLE_PICKER_API_KEY
    // existed answers pickerApiKey:null forever, and the grant step reported
    // "not configured" on a site that was serving the key. The grant flow has to
    // re-ask the server rather than trust the stale global.
    window.__cwaPickerApiKey = null;
    window.__cwaGoogleClientId = "786778645862-fake.apps.googleusercontent.com";
    // A fake Google Picker. The real one is a cross-origin iframe that cannot
    // run headless, so what is under test here is OUR half: that the ids handed
    // to setFileIds are exactly this selection's attachments, batched, and that
    // the result is reported honestly when Google returns fewer than offered.
    window.__pickerCalls = [];
    const picked = [];
    window.gapi = { load: (_name, opts) => opts.callback() };
    window.google = {
      ...(window.google || {}),
      picker: {
        Action: { PICKED: "picked", CANCEL: "cancel" },
        Feature: { MULTISELECT_ENABLED: "multi" },
        DocsView: class {
          setFileIds(ids) { this.ids = String(ids).split(","); return this; }
        },
        PickerBuilder: class {
          setDeveloperKey(k) { this.key = k; return this; }
          setOAuthToken(t) { this.token = t; return this; }
          setAppId(a) { this.appId = a; return this; }
          setTitle(t) { this.title = t; return this; }
          addView(v) { this.view = v; return this; }
          enableFeature(f) { this.feature = f; return this; }
          setCallback(cb) { this.cb = cb; return this; }
          build() { return this; }
          setVisible() {
            window.__pickerCalls.push({ ids: this.view.ids, key: this.key, appId: this.appId, feature: this.feature });
            // Return every offered id but the last — standing in for the ~8% of
            // old attachments Drive drops because they no longer exist.
            const offered = this.view.ids;
            const granted = offered.slice(0, Math.max(0, offered.length - 1));
            picked.push(...granted);
            setTimeout(() => this.cb({ action: "picked", docs: granted.map((id) => ({ id })) }), 0);
          }
        },
      },
    };
  });
  await page.waitForTimeout(700);

  await page.click('.study-tab-btn[data-tab="manage"]');
  await page.waitForTimeout(250);

  // --- 1. the rebuild button reports under itself --------------------------
  const resting = await page.evaluate(() => {
    const el = document.getElementById("kbRebuildStatus");
    const btn = document.getElementById("kbRebuildBtn");
    if (!el || !btn) return null;
    // DOM order, not geometry: a hidden element has no box to measure.
    const follows = !!(btn.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      hidden: el.hidden,
      follows,
      sameBlock: btn.closest(".study-manage-block") === el.closest(".study-manage-block"),
    };
  });
  assert.ok(resting, "the rebuild status strip exists");
  assert.equal(resting.hidden, true, "it stays out of the way until a run starts");
  assert.equal(resting.follows, true, "it follows the button that starts the run");
  assert.equal(resting.sameBlock, true, "it lives in the same card as the button, not on a panel above it");

  // --- 2. a run that finds nothing says so, where it was started -----------
  await page.click("#kbRebuildBtn");
  await page.waitForFunction(
    () => /up to date|Updated|Nothing found/.test(document.getElementById("kbRebuildStatus")?.textContent || ""),
    null,
    { timeout: 20000 },
  );
  const ran = await page.evaluate(() => {
    const el = document.getElementById("kbRebuildStatus");
    const btn = document.getElementById("kbRebuildBtn");
    return {
      hidden: el.hidden,
      text: el.querySelector(".manage-run-text").textContent,
      below: el.getBoundingClientRect().top >= btn.getBoundingClientRect().bottom,
      height: el.getBoundingClientRect().height,
      // The full-page build card lives above the Study tab row; a Manage run
      // must not pop it open behind the user's back.
      buildPanelHidden: document.getElementById("kbBuildPanel").hidden,
      bannerHidden: document.getElementById("kbChangesBanner").hidden,
    };
  });
  assert.equal(ran.hidden, false, "the run has to report from Manage, not on a panel above it");
  assert.ok(ran.height > 0, "the strip has to actually render");
  assert.equal(ran.below, true, "and it has to render under the button, where the click was");
  assert.match(ran.text, /Already up to date/, `a rebuild that found nothing should say so, saw: ${ran.text}`);
  assert.equal(ran.buildPanelHidden, true, "a Manage run must not open the full-page build card");
  assert.equal(ran.bannerHidden, true, "and it must clear the 'something to update' banner it just answered");
  console.log(`✓ rebuild reports under its own button: "${ran.text}"`);

  // --- 3. the picker, and what narrowing does ------------------------------
  await page.click('.manage-tab-btn[data-manage-tab="export"]');
  await page.waitForTimeout(250);
  const classes = await page.$$eval(".export-class-row .export-class-name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(classes, ["Dejepis", "Matematika"], `class picker should list both classes, saw ${classes.join()}`);

  const summaryFor = () => page.textContent("#kbExportSummary");

  // "Select shown" — a filtered list must tick only what is visible, not
  // every class that exists (the bug: Select all ticked everything).
  await page.fill("#kbExportClassFilter", "mate");
  await page.waitForTimeout(200);
  assert.equal(await page.textContent("#kbExportSelectAll"), "Select shown", "the button relabels while filtering");
  await page.click("#kbExportSelectAll");
  await page.waitForTimeout(150);
  const checkedWhileFiltered = await page.$$eval(
    '.export-class-row input[type="checkbox"]:checked',
    (els) => els.map((e) => e.value),
  );
  assert.deepEqual(checkedWhileFiltered, ["Matematika"], "Select shown must not tick the class the filter hid");
  await page.fill("#kbExportClassFilter", "");
  await page.waitForTimeout(200);

  await page.click("#kbExportSelectAll");
  await page.waitForTimeout(150);
  assert.match(await summaryFor(), /4 items from 2 classes/, `all classes: ${await summaryFor()}`);

  await page.click("#kbExportSelectNone");
  await page.click('.export-class-row input[value="Matematika"]');
  await page.waitForTimeout(150);
  assert.match(await summaryFor(), /3 items from 1 class/, `one class: ${await summaryFor()}`);

  // Year narrowing must move the per-class COUNT, not just the summary line —
  // this is the "filters don't really work" bug: the row itself never changed.
  const rowMetaFor = (name) => page.$eval(
    `.export-class-row:has(input[value="${name}"]) .export-class-meta`,
    (el) => el.textContent,
  );
  const beforeYear = await rowMetaFor("Matematika");
  await page.selectOption("#kbExportYear", "2024-25");
  await page.waitForTimeout(150);
  const afterYear = await rowMetaFor("Matematika");
  assert.notEqual(beforeYear, afterYear, `the class row's own count must react to the year filter: ${beforeYear} → ${afterYear}`);
  assert.match(await summaryFor(), /2 items/, `one class + one year: ${await summaryFor()}`);

  await page.uncheck('.kb-export-kind[value="assignment"]');
  await page.waitForTimeout(150);
  assert.match(await summaryFor(), /1 item/, `materials only: ${await summaryFor()}`);
  await page.check('.kb-export-kind[value="assignment"]');
  await page.waitForTimeout(150);
  console.log("✓ Select shown respects the filter; year/type narrow the row counts and the summary");

  // --- 4. Download, with the grant folded in -------------------------------
  await page.check("#kbExportAttachments");
  await page.waitForTimeout(150);
  assert.match(await summaryFor(), /plus up to 2 attachments/, `attachment count: ${await summaryFor()}`);
  assert.equal(await page.evaluate(() => document.getElementById("kbExportGrant")), null, "the separate grant block is gone");
  assert.equal(await page.evaluate(() => document.getElementById("kbExportGrantHint").hidden), false, "the one-line hint takes its place");

  const download = page.waitForEvent("download", { timeout: 30000 });
  await page.click("#kbExportRun");
  await page.waitForFunction(
    () => /Google needs you to confirm/.test(document.getElementById("kbExportProgress")?.textContent || ""),
    null,
    { timeout: 10000 },
  );
  const file = await download;
  assert.match(file.suggestedFilename(), /^Matematika-\d{4}-\d{2}-\d{2}\.zip$/, `zip name: ${file.suggestedFilename()}`);

  const pickerCalls = await page.evaluate(() => window.__pickerCalls);
  assert.equal(pickerCalls.length, 1, "two attachments fit in one picker round, opened straight from Download");
  assert.equal(pickerCalls[0].key, "served-picker-key", "the key must come from the server, not from a stale cached global");
  assert.deepEqual(pickerCalls[0].ids.sort(), ["DOC_TWO_ID_X", "FILE_ONE_ID_X"], "the picker is handed exactly this selection's attachments");
  assert.equal(pickerCalls[0].appId, "786778645862", "the picker gets the project number as its app id");
  assert.equal(pickerCalls[0].feature, "multi", "multi-select must be on, or a class is one click per file");
  console.log("✓ Download opens the picker itself for exactly this class's ids — no separate grant button");

  const bytes = readFileSync(await file.path());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, "the download is a real zip");
  const text = bytes.toString("latin1");
  for (const expected of [
    "README.md",
    "Matematika/Assignments/Algebra/Quadratics worksheet.md",
    "Matematika/Materials/Algebra/Formula sheet.md",
    "Matematika/Assignments/Attachments/Quadratics worksheet/Worksheet.pdf",
  ]) {
    assert.ok(text.includes(expected), `zip should contain ${expected}`);
  }
  assert.ok(!text.includes("Old logarithms test"), "the 2023-24 note was filtered out and must not be in the zip");

  const after = await page.evaluate(() => ({
    summary: document.getElementById("kbExportSummary").textContent,
    skippedHidden: document.getElementById("kbExportSkipped").hidden,
    skippedText: document.getElementById("kbExportSkipped").textContent,
  }));
  assert.match(after.summary, /1 of 2 attachments/, `summary should be honest about the 403: ${after.summary}`);
  assert.equal(after.skippedHidden, false, "the file that could not be downloaded is listed");
  assert.match(after.skippedText, /Formulas/);
  console.log("✓ zip holds one file per item plus the attachments it could fetch");

  // --- 5. only what's new ---------------------------------------------------
  // Attachments off, isolating the notes-history side of "only what's new":
  // with them on, the material note would stay "new" forever because its
  // attachment (DOC_TWO_ID_X) 403s every time and never successfully
  // downloads — correctly so; a skipped file must keep retrying next time.
  await page.uncheck("#kbExportAttachments");
  await page.waitForTimeout(150);
  assert.match(await page.textContent("#kbExportRun"), /All caught up/, `second run should offer nothing new: ${await page.textContent("#kbExportRun")}`);
  const pickerCallsBefore = pickerCalls.length;
  const secondDownload = page.waitForEvent("download", { timeout: 30000 });
  await page.click("#kbExportRunAlt"); // "Download everything again" — the escape hatch, not the default path
  await secondDownload;
  assert.equal((await page.evaluate(() => window.__pickerCalls)).length, pickerCallsBefore, "a class already fully granted must not reopen the picker");
  console.log("✓ a second export of the same class needs no picker");

  // Now add one new note to the seeded class — Download should then offer
  // only what changed, not the whole class again.
  await page.evaluate(async () => {
    const kb = await import("/kb-local.js");
    const bundle = await kb.loadKbBundle();
    bundle.notes.push({
      p: "2024-25/Matematika/New-worksheet", t: "New worksheet", course: "Matematika", y: "2024-25",
      topic: "Algebra", kind: "assignment", s: "New worksheet — summary", x: "Do it.\n\nDue: 2025-05-01",
    });
    await kb.saveMergedKbBundle(bundle);
  });
  // showKbView() reloads the corpus kb.js keeps cached (localKbBundle) —
  // without this the panel would keep showing the pre-mutation notes.
  await page.evaluate(async () => { const kb = await import("/kb.js"); await kb.showKbView(); });
  await page.click('.manage-tab-btn[data-manage-tab="export"]');
  await page.waitForTimeout(250);
  assert.match(await page.textContent("#kbExportRun"), /1 new item/, `a fresh note should surface as "new": ${await page.textContent("#kbExportRun")}`);
  console.log("✓ a new note in an already-exported class offers only what's new");

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}

console.log("\nmanage export passed");
