// kb_resultcount_test.mjs — TDD gate for ROADMAP #55:
// "search result count + 'showing N of M notes' and a 'clear filters' control
// when course/year chips are active."
//
// Covers:
//   1. /api/kb-search exposes `filteredCount`: the number of notes in the
//      corpus the current result set was drawn from (post-facet-filter,
//      pre-limit). Without a facet filter this equals the whole DB size; with
//      a course/year filter it equals the count inside that facet.
//   2. buildResultSummary({shown,total,course,year}) — a pure client helper
//      that turns the counts into the human "Showing N of M notes" string,
//      appending the active filter list when a facet is selected.
//
// Run: node scripts/kb_resultcount_test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import kbSearch from "../api/kb-search.js";
import { buildResultSummary } from "../kb.js";
import { saveBundle } from "../api/kb-store.js";

function makeReq(url, method = "GET") {
  return new Request("http://localhost" + url, { method });
}

// Distinct courses/years so we can assert facet narrowing behaviour.
function sampleBundle() {
  return {
    version: 1,
    source: "bundle",
    generatedAt: new Date().toISOString(),
    notes: [
      { t: "Cover Letter Guide", s: "How to write a strong cover letter.", x: "Use the STAR method in your cover letter.", course: "ELA 1 Gama", y: "2023-24", topic: "Writing", p: "" },
      { t: "Biology A", s: "Mitochondria are the powerhouse of the cell.", x: "Biology body about mitochondria.", course: "BEng Y1", y: "2023-24", topic: "Science", p: "" },
      { t: "Biology B", s: "Photosynthesis converts light to energy.", x: "Photosynthesis happens in the chloroplasts.", course: "BEng Y1", y: "2023-24", topic: "Science", p: "" },
      { t: "Biology C", s: "DNA stores genetic information.", x: "DNA is a double helix.", course: "BEng Y1", y: "2022-23", topic: "Science", p: "" },
    ],
    years: ["2023-24", "2022-23"],
    courses: ["ELA 1 Gama", "BEng Y1"],
  };
}

test("kb-search exposes filteredCount = whole DB size when no facet filter is set", async () => {
  await saveBundle(sampleBundle());
  const r = await kbSearch(makeReq("/api/kb-search?q=biology&limit=8"));
  assert.equal(r.status, 200);
  const d = await r.json();
  // All three "Biology" notes match "biology"; none are facet-filtered, so the
  // result set was drawn from the entire 4-note corpus.
  assert.equal(d.filteredCount, 4, "no facet filter -> filteredCount is the whole DB");
  assert.ok(Array.isArray(d.results), "results still present");
});

test("kb-search narrows filteredCount to the active facet (course filter)", async () => {
  await saveBundle(sampleBundle());
  // BEng Y1 has 3 notes; querying a biology term inside that course should
  // report filteredCount === 3 (the facet the results are drawn from).
  const r = await kbSearch(makeReq("/api/kb-search?q=biology&course=BEng%20Y1&limit=8"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.filteredCount, 3, "filteredCount should equal the facet size (BEng Y1 = 3 notes)");
  assert.ok(d.results.every((n) => n.course === "BEng Y1"), "every result inside the facet");
});

test("kb-search narrows filteredCount to the active facet (year filter)", async () => {
  await saveBundle(sampleBundle());
  const r = await kbSearch(makeReq("/api/kb-search?q=biology&year=2022-23&limit=8"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.filteredCount, 1, "2022-23 has exactly 1 note");
});

// --- Pure client helper (drives the #kbResultCount text + clear-filters UI) ---

test("buildResultSummary shows 'N of M notes' with no active filter", () => {
  assert.equal(
    buildResultSummary({ shown: 8, total: 3961 }),
    "Showing 8 of 3961 notes"
  );
});

test("buildResultSummary appends the active course filter", () => {
  assert.equal(
    buildResultSummary({ shown: 3, total: 10, course: "BEng Y1" }),
    "Showing 3 of 10 notes (filtered by course: BEng Y1)"
  );
});

test("buildResultSummary appends both active filters", () => {
  assert.equal(
    buildResultSummary({ shown: 2, total: 4, course: "BEng Y1", year: "2023-24" }),
    "Showing 2 of 4 notes (filtered by course: BEng Y1, year: 2023-24)"
  );
});

test("buildResultSummary uses singular 'note' when total is 1", () => {
  assert.equal(
    buildResultSummary({ shown: 1, total: 1 }),
    "Showing 1 of 1 note"
  );
});
