import { test } from "node:test";
import assert from "node:assert/strict";
import { browseKbBundle } from "../kb-local.js";

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
  const result = browseKbBundle({
    ...bundle,
    notes: [
      { ...bundle.notes[0], course: "Math" },
      { ...bundle.notes[1], course: "Math" },
      { ...bundle.notes[2], course: "Math" },
    ],
  }, "Math", {
    recentDays: 7,
    today: "2026-08-04",
    progress: {
      0: { opened: 1, lastOpened: "2026-08-04" },
      1: { opened: 1, lastOpened: "2026-07-20" },
      2: { opened: 1, lastOpened: "2026-07-29" },
    },
  });

  assert.deepEqual(result.notes.map((note) => note.noteIndex), [0, 2]);
});
