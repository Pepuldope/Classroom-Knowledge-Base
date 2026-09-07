import test from "node:test";
import assert from "node:assert/strict";
import { studyTabModel, studyTabForAction, STUDY_TABS, DEFAULT_STUDY_TAB } from "../study-tabs.js";
import { curriculumModel, prettifySubjectLabel } from "../kb-curriculum.js";

// --- tabs -------------------------------------------------------------------

test("exactly one panel is visible at a time", () => {
  for (const tab of STUDY_TABS) {
    const model = studyTabModel(tab);
    assert.equal(model.active, tab);
    assert.equal(model.panels.filter((p) => !p.hidden).length, 1);
    assert.equal(model.panels.find((p) => !p.hidden).tab, tab);
  }
});

test("an unknown tab falls back to Search rather than blanking the page", () => {
  for (const bad of ["archive", "", null, undefined, 42]) {
    assert.equal(studyTabModel(bad).active, DEFAULT_STUDY_TAB);
    assert.equal(studyTabModel(bad).panels.filter((p) => !p.hidden).length, 1);
  }
});

test("searching moves to the results, whatever tab you were on", () => {
  // Otherwise typing while on Curriculum searches a panel you cannot see.
  for (const from of STUDY_TABS) assert.equal(studyTabForAction("search", from), "search");
});

test("opening a course lands on Browse", () => {
  // The Curriculum chips are a way into the corpus, not a dead end.
  assert.equal(studyTabForAction("open-course", "curriculum"), "browse");
});

test("an unrelated action leaves the current tab alone", () => {
  assert.equal(studyTabForAction("noop", "manage"), "manage");
  assert.equal(studyTabForAction("noop", "nonsense"), DEFAULT_STUDY_TAB);
});

// --- curriculum -------------------------------------------------------------

const note = (over = {}) => ({
  p: `p-${Math.random()}`,
  t: "Note",
  course: "Matematika Y3",
  y: "2023-24",
  topic: "Algebra",
  kind: "note",
  s: "",
  x: "",
  ...over,
});

test("the matrix is derived from notes, not the courses array", () => {
  // kb-merge.js leaves courses[].y null because a course spans years once the
  // corpus is merged; the year only survives on the notes. Reading courses[]
  // would produce an empty matrix.
  const bundle = {
    notes: [note({ y: "2023-24" }), note({ y: "2024-25" })],
    courses: [{ name: "Matematika Y3", y: null, family: null, noteCount: 2 }],
  };
  const { years, rows } = curriculumModel(bundle);
  assert.deepEqual(years, ["2023-24", "2024-25"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].byYear.size, 2);
});

test("same subject across years and tracks lands on one row", () => {
  const bundle = {
    notes: [
      note({ course: "Matematika Y3", y: "2023-24" }),
      note({ course: "Matematika Y4", y: "2024-25" }),
    ],
  };
  const { rows } = curriculumModel(bundle);
  assert.equal(rows.length, 1, "Y3 and Y4 should share a row");
  assert.equal(rows[0].multiYear, true);
});

test("a derived class-type family groups a row when present", () => {
  const bundle = {
    notes: [
      note({ course: "Fyzika", y: "2023-24", family: "Science/Math" }),
      note({ course: "Matematika", y: "2024-25", family: "Science/Math" }),
    ],
  };
  const { rows } = curriculumModel(bundle);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Science/Math");
});

test("multi-year rows come first", () => {
  const bundle = {
    notes: [
      note({ course: "Aaa Only", y: "2024-25" }),
      note({ course: "Zzz Both", y: "2023-24" }),
      note({ course: "Zzz Both", y: "2024-25" }),
    ],
  };
  const { rows } = curriculumModel(bundle);
  assert.equal(rows[0].multiYear, true, "the two-year subject sorts above the alphabetically-earlier one");
});

test("cells count notes and distinct topics", () => {
  const bundle = {
    notes: [
      note({ topic: "Algebra" }),
      note({ topic: "Algebra" }),
      note({ topic: "Geometria" }),
    ],
  };
  const cellEntry = curriculumModel(bundle).rows[0].byYear.get("2023-24")[0];
  assert.equal(cellEntry.noteCount, 3);
  assert.equal(cellEntry.topicCount, 2);
});

test("a cross-link cluster marks the cell", () => {
  const bundle = {
    notes: [note({ topic: "SNP", course: "Dejepis", y: "2023-24" })],
    clusters: [{ topics: [{ y: "2023-24", course: "Dejepis", topic: "SNP" }] }],
  };
  assert.equal(curriculumModel(bundle).rows[0].byYear.get("2023-24")[0].linked, true);
});

test("notes with no course or year still appear", () => {
  const bundle = { notes: [note({ course: undefined, y: undefined, topic: undefined })] };
  const { years, rows } = curriculumModel(bundle);
  assert.deepEqual(years, ["undated"]);
  assert.equal(rows.length, 1);
});

test("an empty or malformed bundle yields an empty matrix", () => {
  for (const bad of [null, undefined, {}, { notes: [] }, { notes: "nope" }]) {
    assert.deepEqual(curriculumModel(bad), { years: [], rows: [] });
  }
});

test("subject labels are readable", () => {
  assert.equal(prettifySubjectLabel("slovensky_jazyk"), "Slovensky Jazyk");
  assert.equal(prettifySubjectLabel(""), "(untitled)");
});

test("a multi-year row is labelled by subject, not by one of its years", () => {
  // "Matematika Y3" as the label for a row covering Y3 and Y4 reads as a
  // single year.
  const bundle = {
    notes: [
      note({ course: "Matematika Y3", y: "2023-24" }),
      note({ course: "Matematika Y4", y: "2024-25" }),
    ],
  };
  assert.equal(curriculumModel(bundle).rows[0].label, "Matematika");
});
