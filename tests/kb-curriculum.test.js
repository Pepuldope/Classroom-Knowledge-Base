// The Curriculum matrix filter/sort model. Kept pure so the grid can be
// asserted without a browser — the view is a function of (bundle, controls).
import test from "node:test";
import assert from "node:assert/strict";
import {
  curriculumModel,
  curriculumControlsModel,
  curriculumYears,
  prettifySubjectLabel,
} from "../kb-curriculum.js";

// Shaped after the owner's real corpus: one subject running across three years
// under three different course names, plus two single-year subjects.
const BUNDLE = {
  notes: [
    { course: "NaE 1 T", y: "2023-24", topic: "Intro" },
    { course: "NaE 2.T", y: "2024-25", topic: "Pitch" },
    { course: "NaE Y3 3.T", y: "2025-26", topic: "Sprint 1" },
    { course: "NaE Y3 3.T", y: "2025-26", topic: "Sprint 2" },
    { course: "Matematika 1", y: "2023-24", topic: "Algebra" },
    { course: "Science Y3", y: "2025-26", topic: "Optics" },
  ],
};

test("multi-year subjects lead by default, and years are the column axis", () => {
  const m = curriculumModel(BUNDLE);
  assert.deepEqual(m.years, ["2023-24", "2024-25", "2025-26"]);
  assert.deepEqual(curriculumYears(BUNDLE), ["2023-24", "2024-25", "2025-26"]);
  assert.equal(m.rows[0].label, "Nae T", "the three-year subject comes first");
  assert.equal(m.rows[0].multiYear, true);
  assert.equal(m.rows[0].byYear.size, 3);
  assert.equal(m.filtered, false);
});

test("sorting by name and by volume", () => {
  assert.deepEqual(curriculumModel(BUNDLE, { sort: "alpha" }).rows.map((r) => r.label),
    ["Matematika", "Nae T", "Science"]);
  assert.deepEqual(curriculumModel(BUNDLE, { sort: "notes" }).rows.map((r) => r.label),
    ["Nae T", "Matematika", "Science"]);
});

test("search matches a course name, not only the folded row label", () => {
  // The row is labelled "Nae T"; the user types what is on their timetable.
  const m = curriculumModel(BUNDLE, { q: "Y3 3.T" });
  assert.deepEqual(m.rows.map((r) => r.label), ["Nae T"]);
  assert.equal(m.filtered, true);
  // Columns with nothing left in them are dropped, so a search does not leave
  // empty year columns padding the grid.
  assert.deepEqual(m.years, ["2023-24", "2024-25", "2025-26"]);
  assert.deepEqual(curriculumModel(BUNDLE, { q: "matematika" }).years, ["2023-24"]);
});

test("the year range clips columns, in either order", () => {
  const forward = curriculumModel(BUNDLE, { yearFrom: "2024-25", yearTo: "2025-26" });
  assert.deepEqual(forward.years, ["2024-25", "2025-26"]);
  // Picking the years the other way round means the same range.
  const backward = curriculumModel(BUNDLE, { yearFrom: "2025-26", yearTo: "2024-25" });
  assert.deepEqual(backward.years, forward.years);
  // A one-sided range is open at the other end.
  assert.deepEqual(curriculumModel(BUNDLE, { yearFrom: "2025-26" }).years, ["2025-26"]);
  assert.deepEqual(curriculumModel(BUNDLE, { yearTo: "2023-24" }).years, ["2023-24"]);
  // allYears keeps the full axis so the controls can still offer hidden years.
  assert.deepEqual(forward.allYears, ["2023-24", "2024-25", "2025-26"]);
});

test("no match is an empty grid, not a broken one", () => {
  const m = curriculumModel(BUNDLE, { q: "geography" });
  assert.deepEqual(m.rows, []);
  assert.deepEqual(m.years, []);
  assert.equal(m.filtered, true);
  assert.equal(m.totalRows, 3, "the unfiltered total is still reported");
});

test("controls normalize, and an unknown sort falls back", () => {
  assert.deepEqual(curriculumControlsModel({ q: "  x  ", sort: "sideways" }),
    { q: "x", yearFrom: "", yearTo: "", sort: "span" });
  assert.deepEqual(curriculumControlsModel(), { q: "", yearFrom: "", yearTo: "", sort: "span" });
  assert.equal(curriculumControlsModel({ sort: "notes" }).sort, "notes");
});

test("an empty corpus yields an empty model rather than throwing", () => {
  assert.deepEqual(curriculumModel({ notes: [] }), { years: [], rows: [], allYears: [], totalRows: 0, filtered: false });
  assert.deepEqual(curriculumModel(null).rows, []);
  assert.equal(prettifySubjectLabel(""), "(untitled)");
  assert.equal(prettifySubjectLabel("nae t"), "Nae T");
});
