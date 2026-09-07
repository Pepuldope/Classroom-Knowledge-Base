// study_tabs_test.mjs — the merged Study page: four tabs, one job each.
//
// Archive and the Knowledge Base were separate top-level pages with two note
// stores, two search implementations and two browse UIs. They are one page now,
// so what this guards is that the merge stayed merged: exactly one panel
// visible at a time, the Curriculum matrix (the one thing only Archive had)
// still renders, its chips lead into Browse, and Manage exposes the build and
// import controls that used to live on the other page.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/study_tabs_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";

const note = (course, y, topic, title) => ({
  p: `${y}/${course}/${topic}/${title}`.replace(/\s+/g, "-"),
  t: title,
  course,
  y,
  topic,
  kind: "note",
  s: `${title} — summary`,
  x: `Body of ${title}.`,
});

// Two years of the same subject plus a single-year one, so the matrix has a
// multi-year row to sort first and a second row to sort after it.
const BUNDLE = {
  version: 1,
  source: "classroom",
  generatedAt: new Date().toISOString(),
  years: ["2023-24", "2024-25"],
  courses: [],
  clusters: [],
  notes: [
    note("Matematika Y3", "2023-24", "Algebra", "Quadratics"),
    note("Matematika Y3", "2023-24", "Geometria", "Triangles"),
    note("Matematika Y4", "2024-25", "Algebra", "Logarithms"),
    note("Dejepis", "2024-25", "SNP", "Uprising"),
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });

  // Seed the local corpus, then open Study the way the nav does.
  await page.evaluate(async (bundle) => {
    const local = await import("/kb-local.js");
    await local.saveKbBundle(bundle);
    const kb = await import("/kb.js");
    document.getElementById("kbView").hidden = false;
    document.getElementById("plannerView").hidden = true;
    await kb.showKbView();
  }, BUNDLE);
  await page.waitForTimeout(700);

  const visiblePanels = async () =>
    page.evaluate(() =>
      ["search", "browse", "curriculum", "manage"].filter((t) => {
        const el = document.getElementById(`studyPanel-${t}`);
        return el && !el.hidden;
      }));

  // --- one panel at a time -------------------------------------------------
  for (const tab of ["search", "browse", "curriculum", "manage"]) {
    await page.click(`.study-tab-btn[data-tab="${tab}"]`);
    await page.waitForTimeout(250);
    const shown = await visiblePanels();
    assert.deepEqual(shown, [tab], `only the ${tab} panel should be visible, saw ${shown.join()}`);
    const selected = await page.getAttribute(`.study-tab-btn[data-tab="${tab}"]`, "aria-selected");
    assert.equal(selected, "true", `${tab} tab should report itself selected`);
  }
  console.log("✓ exactly one panel visible per tab, aria-selected tracks it");

  // --- curriculum ----------------------------------------------------------
  await page.click('.study-tab-btn[data-tab="curriculum"]');
  await page.waitForTimeout(300);
  const matrix = await page.evaluate(() => {
    const grid = document.getElementById("kbCurriculumGrid");
    return {
      years: [...grid.querySelectorAll(".curriculum-col-label")].map((e) => e.textContent),
      rowLabels: [...grid.querySelectorAll(".curriculum-row-label")].map((e) => e.textContent).filter(Boolean),
      chips: [...grid.querySelectorAll(".curriculum-chip")].map((e) => e.textContent.trim()),
      multiYearFirst: grid.querySelectorAll(".curriculum-row")[1]?.classList.contains("curriculum-row-multi"),
    };
  });
  assert.deepEqual(matrix.years, ["2023-24", "2024-25"], "both years are columns");
  assert.ok(matrix.chips.length >= 3, `expected a chip per course-year, saw ${matrix.chips.length}`);
  assert.ok(matrix.chips.some((c) => /3 notes|2 notes/.test(c)), "chips carry note counts");
  assert.equal(matrix.multiYearFirst, true, "the two-year subject sorts to the top");
  console.log(`✓ curriculum matrix: ${matrix.rowLabels.length} subjects × ${matrix.years.length} years`);

  // --- a chip is a way into the corpus ------------------------------------
  await page.click(".curriculum-chip");
  await page.waitForTimeout(500);
  const afterChip = await visiblePanels();
  assert.deepEqual(afterChip, ["browse"], "a curriculum chip should land on Browse");
  const browseVisible = await page.evaluate(() => !document.getElementById("kbBrowse").hidden);
  assert.equal(browseVisible, true, "the browse panel should be populated, not just switched to");
  console.log("✓ curriculum chip opens the course in Browse");

  // --- manage --------------------------------------------------------------
  await page.click('.study-tab-btn[data-tab="manage"]');
  await page.waitForTimeout(200);
  const manage = await page.evaluate(() =>
    ["kbRebuildBtn", "kbManageLoadFileLink", "kbExportJson", "kbExportMd", "kbExportCsv"]
      .filter((id) => {
        const el = document.getElementById(id);
        return !el || el.offsetParent === null;
      }));
  assert.deepEqual(manage, [], `Manage should expose build/import/export, missing or hidden: ${manage.join()}`);
  console.log("✓ manage exposes build, import and the three exports");

  // --- arriving from the Planner lands on the results ---------------------
  // The search box lives inside the Search panel, so a user cannot type from
  // another tab. The path that CAN arrive mid-tab is programmatic:
  // kbSearchTopic(), used by the Planner's "🔍 KB" button and by the "From
  // your notes" chips. It must show the results rather than run a search
  // behind whichever panel happens to be open.
  await page.click('.study-tab-btn[data-tab="curriculum"]');
  await page.waitForTimeout(150);
  await page.evaluate(async () => {
    const kb = await import("/kb.js");
    kb.kbSearchTopic("Quadratics");
  });
  await page.waitForTimeout(700);
  const afterSearch = await visiblePanels();
  assert.deepEqual(afterSearch, ["search"], "a Planner jump should show the results panel");
  const query = await page.inputValue("#kbSearchInput");
  assert.equal(query, "Quadratics", "the query should be prefilled");
  console.log("✓ a Planner jump lands on Search with the query filled");

  // --- the merged page has one browse UI, not two -------------------------
  const duplicates = await page.evaluate(() => ({
    archiveView: !!document.getElementById("archiveView"),
    archiveBrowse: !!document.getElementById("archiveBrowse"),
    archiveSearch: !!document.getElementById("archiveSearchInput"),
    archiveNoteModal: !!document.getElementById("archiveNoteModal"),
    navButtons: document.querySelectorAll(".view-toggle-btn").length,
  }));
  assert.equal(duplicates.archiveView, false, "the Archive view should be gone");
  assert.equal(duplicates.archiveBrowse, false, "the duplicate browse tree should be gone");
  assert.equal(duplicates.archiveSearch, false, "the duplicate search box should be gone");
  assert.equal(duplicates.archiveNoteModal, false, "the duplicate note modal should be gone");
  assert.equal(duplicates.navButtons, 2, "two top-level pages: Planner and Study");
  console.log("✓ no duplicate browse, search, or note modal remains");

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
} finally {
  await browser.close();
}

console.log("\nstudy page passed");
