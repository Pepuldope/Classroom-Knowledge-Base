import { test } from "node:test";
import assert from "node:assert/strict";
import { browseKbBundle, sortBrowseCourses } from "../kb-local.js";

const bundle = {
  version: 1,
  generatedAt: "2026-07-31T10:00:00.000Z",
  years: ["2025"],
  notes: [
    { t: "Algebra", course: "Math", y: "2025", s: "Quadratic equations" },
    { t: "Biology", course: "Science", y: "2024", x: "Cells and tissues" },
    { t: "Geometry", course: "Math", y: "2024", x: "Triangles" },
  ],
};

test("browseKbBundle returns local course facets without a network response", () => {
  const result = browseKbBundle(bundle);

  assert.deepEqual(result.courses, [
    { course: "Math", count: 2, years: ["2024", "2025"] },
    { course: "Science", count: 1, years: ["2024"] },
  ]);
  assert.equal(result.meta.noteCount, 3);
  assert.equal(result.notes, undefined);
});

test("browseKbBundle returns recency-sorted course notes with snippets", () => {
  const result = browseKbBundle(bundle, "Math");

  assert.deepEqual(result.notes.map((note) => ({
    t: note.t,
    noteIndex: note.noteIndex,
    _snippet: note._snippet,
  })), [
    { t: "Algebra", noteIndex: 0, _snippet: "Quadratic equations" },
    { t: "Geometry", noteIndex: 2, _snippet: "Triangles" },
  ]);
});

test("browseKbBundle applies kind, family, and explicit sort filters locally", () => {
  const result = browseKbBundle({
    ...bundle,
    notes: [
      { ...bundle.notes[0], kind: "assignment", family: "language" },
      { ...bundle.notes[1], kind: "note", family: "science" },
      { ...bundle.notes[2], kind: "assignment", family: "math" },
    ],
  }, "Math", { kind: "assignment", family: "math", sort: "title" });
  assert.deepEqual(result.notes.map((note) => ({ t: note.t, kind: note.kind, family: note.family })), [
    { t: "Geometry", kind: "assignment", family: "math" },
  ]);
});

test("browseKbBundle applies a year filter alongside course facets", () => {
  const result = browseKbBundle(bundle, "Math", { year: "2024" });

  assert.deepEqual(result.notes.map((note) => ({ t: note.t, y: note.y, noteIndex: note.noteIndex })), [
    { t: "Geometry", y: "2024", noteIndex: 2 },
  ]);
});

test("browseKbBundle can filter to notes opened in the last seven days", () => {
  // Progress is keyed by note PATH, not array position — see study-progress.js.
  const notes = [
    { ...bundle.notes[0], course: "Math", p: "2025/vault/Math/Algebra" },
    { ...bundle.notes[1], course: "Math", p: "2024/vault/Math/Biology" },
    { ...bundle.notes[2], course: "Math", p: "2024/vault/Math/Geometry" },
  ];
  const progress = {
    "2025/vault/Math/Algebra": { opened: 1, lastOpened: "2026-08-04" },
    "2024/vault/Math/Biology": { opened: 1, lastOpened: "2026-07-20" },
    "2024/vault/Math/Geometry": { opened: 1, lastOpened: "2026-07-29" },
  };
  const result = browseKbBundle({ ...bundle, notes }, "Math", {
    recentDays: 7, today: "2026-08-04", progress,
  });
  assert.deepEqual(result.notes.map((note) => note.noteIndex), [0, 2]);

  // The whole point: reordering the corpus must not move the recency flags.
  const reordered = [notes[2], notes[0], notes[1]];
  const after = browseKbBundle({ ...bundle, notes: reordered }, "Math", {
    recentDays: 7, today: "2026-08-04", progress,
  });
  assert.deepEqual(after.notes.map((note) => note.t).sort(), ["Algebra", "Geometry"],
    "the same two notes stay 'recently studied' after a reorder");
});

test("browse facets feed the filter controls", async () => {
  const { browseFamilyFacet, browseTopicFacet, sortBrowseCourses } = await import("../kb-local.js");
  const bundle = {
    notes: [
      { course: "NaE Y3 3.T", y: "2025-26", topic: "Sprint 1", family: "Business" },
      { course: "NaE Y3 3.T", y: "2025-26", topic: "Sprint 2", family: "Business" },
      { course: "NaE Y3 3.T", y: "2024-25", topic: "Old", family: "Business" },
      { course: "Matematika 1", y: "2023-24", topic: "Algebra", family: "Science/Math" },
    ],
  };
  assert.deepEqual(browseFamilyFacet(bundle), ["Business", "Science/Math"]);
  assert.deepEqual(browseTopicFacet(bundle, "NaE Y3 3.T"), ["Old", "Sprint 1", "Sprint 2"]);
  // Topics narrow with the year, so the list only offers what is reachable.
  assert.deepEqual(browseTopicFacet(bundle, "NaE Y3 3.T", "2025-26"), ["Sprint 1", "Sprint 2"]);
  assert.deepEqual(browseFamilyFacet({ notes: [] }), []);
});

test("the course grid can be sorted by volume, name, or most recent year", () => {
  const courses = [
    { course: "Old Big", count: 40, years: ["2023-24"] },
    { course: "Current", count: 9, years: ["2025-26"] },
    { course: "Middle", count: 20, years: ["2024-25"] },
  ];
  assert.deepEqual(sortBrowseCoursesNames(courses, "notes"), ["Old Big", "Middle", "Current"]);
  assert.deepEqual(sortBrowseCoursesNames(courses, "alpha"), ["Current", "Middle", "Old Big"]);
  // The whole point: what you are taking now, not what has the most notes.
  assert.deepEqual(sortBrowseCoursesNames(courses, "recent"), ["Current", "Middle", "Old Big"]);
  // An unknown sort falls back rather than returning an arbitrary order.
  assert.deepEqual(sortBrowseCoursesNames(courses, "sideways"), ["Old Big", "Middle", "Current"]);
});

test("filtering by topic scopes a course's notes", () => {
  const bundle = {
    notes: [
      { t: "A", course: "NaE", y: "2025-26", topic: "Sprint 1", p: "a" },
      { t: "B", course: "NaE", y: "2025-26", topic: "Sprint 2", p: "b" },
    ],
  };
  const all = browseKbBundle(bundle, "NaE", {});
  assert.equal(all.notes.length, 2);
  const scoped = browseKbBundle(bundle, "NaE", { topic: "Sprint 2" });
  assert.deepEqual(scoped.notes.map((n) => n.t), ["B"]);
  // noteIndex still points into the original notes array, which is what the
  // result cards use to open a note.
  assert.equal(scoped.notes[0].noteIndex, 1);
});

/** Sort helper wrapper: assert on names, which is what the grid renders. */
function sortBrowseCoursesNames(courses, sort) {
  return sortBrowseCourses(courses, sort).map((c) => c.course);
}
