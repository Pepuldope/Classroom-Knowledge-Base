// The "N new courses found in Google Classroom" banner.
//
// Regression: the banner was permanent. It asked "which Classroom courses are
// missing from my corpus?" but answered it from the NOTES, so a course with
// nothing posted in it yet could never be satisfied — "Update now" rebuilt,
// found nothing to add, and the banner returned. Three of the owner's real
// courses are in that state.
import test from "node:test";
import assert from "node:assert/strict";
import { detectClassroomChanges, knownCourseNames } from "../kb.js";
import { mergeBundles } from "../kb-merge.js";

const CLASSROOM = [
  { name: "NaE Y3 3.T" },
  { name: "MATURITA INFO Y4" }, // real, current, and has nothing posted in it
];

test("a course with no notes yet is still a course the corpus knows", () => {
  const bundle = {
    notes: [{ course: "NaE Y3 3.T", y: "2025-26", t: "Pitch" }],
    courses: [{ name: "NaE Y3 3.T", noteCount: 1 }, { name: "MATURITA INFO Y4", noteCount: 0 }],
  };
  assert.deepEqual(detectClassroomChanges(bundle, CLASSROOM), { newCourses: [], hasChanges: false });
});

test("without the courses list it would report the empty course forever", () => {
  // This is the old behaviour, kept as a test so the regression is explicit.
  const notesOnly = { notes: [{ course: "NaE Y3 3.T" }] };
  assert.deepEqual(detectClassroomChanges(notesOnly, CLASSROOM), {
    newCourses: ["MATURITA INFO Y4"],
    hasChanges: true,
  });
});

test("a genuinely new course is still reported", () => {
  const bundle = { notes: [{ course: "NaE Y3 3.T" }], courses: [{ name: "NaE Y3 3.T" }] };
  const changes = detectClassroomChanges(bundle, [...CLASSROOM, { name: "Brand New Class" }]);
  assert.equal(changes.hasChanges, true);
  assert.ok(changes.newCourses.includes("Brand New Class"));
  assert.ok(changes.newCourses.includes("MATURITA INFO Y4"));
});

test("knownCourseNames reads notes, course objects, and legacy bare strings", () => {
  assert.deepEqual([...knownCourseNames({ notes: [{ course: "A" }], courses: [{ name: "B" }, "C"] })].sort(), ["A", "B", "C"]);
  assert.deepEqual([...knownCourseNames(null)], []);
  assert.deepEqual([...knownCourseNames({ notes: [{ course: "  " }], courses: [{ name: "" }] })], []);
});

test("merging does not discard a course that has no notes", () => {
  // Without this, the fix above would survive exactly until the next save.
  const stored = {
    version: 1,
    notes: [{ p: "2025-26/vault/NaE/T/A", course: "NaE Y3 3.T", y: "2025-26" }],
    courses: [{ name: "NaE Y3 3.T", noteCount: 1 }, { name: "MATURITA INFO Y4", noteCount: 0 }],
  };
  const merged = mergeBundles(stored, { version: 1, notes: [] });
  const names = merged.courses.map((c) => c.name);
  assert.ok(names.includes("MATURITA INFO Y4"), `empty course dropped: ${names.join(", ")}`);
  assert.equal(merged.courses.find((c) => c.name === "MATURITA INFO Y4").noteCount, 0);
  // And the banner stays quiet across that round trip.
  assert.equal(detectClassroomChanges(merged, CLASSROOM).hasChanges, false);
});
