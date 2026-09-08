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

// ---------------------------------------------------------------------------
// The whole ingestion chain, not one hop of it.
//
// The first version of this fix tested mergeBundles in isolation and passed
// while the real path stayed broken: kbBundleFromClassroomArchive sits BETWEEN
// the build and the merge, and it rebuilt the course list from the notes —
// discarding the empty course before the merge could preserve it. This test
// runs the path the "Update now" button actually takes.
// ---------------------------------------------------------------------------
test("a course with nothing posted survives the real build -> convert -> merge path", async () => {
  const { bundleFromRaw } = await import("../archive-builder.js");
  const { kbBundleFromClassroomArchive } = await import("../kb-client-build.js");

  // Exactly the owner's situation: one course with coursework, one brand-new
  // course with nothing in it yet.
  const raw = {
    courses: [
      { id: "c1", name: "NaE Y3 3.T", section: "2025/26", creationTime: "2025-07-01T12:31:18.847Z" },
      { id: "c2", name: "MATURITA INFO Y4", section: "2026/2027", creationTime: "2026-06-18T08:59:57.111Z" },
    ],
    courseData: {
      c1: { topics: [{ topicId: "t1", name: "Sprint 1" }], courseWork: [{ id: "w1", title: "Pitch", topicId: "t1" }] },
      c2: {}, // nothing posted, and nothing to fetch
    },
  };

  const archive = bundleFromRaw(raw);
  assert.ok(archive.courses.some((c) => c.name === "MATURITA INFO Y4"),
    "the build itself records every course it saw");
  assert.equal(archive.notes.filter((n) => n.course === "MATURITA INFO Y4").length, 0,
    "and that course legitimately produces no notes");

  const converted = kbBundleFromClassroomArchive(archive);
  assert.ok(converted.courses.some((c) => c.name === "MATURITA INFO Y4"),
    "conversion to the KB schema must not drop it — this is where it was lost");

  const saved = mergeBundles(null, converted);
  assert.ok(saved.courses.some((c) => c.name === "MATURITA INFO Y4"),
    "and neither must the merge that writes it to IndexedDB");

  // The banner is quiet, and stays quiet across a second rebuild.
  const classroom = raw.courses.map((c) => ({ name: c.name }));
  assert.deepEqual(detectClassroomChanges(saved, classroom), { newCourses: [], hasChanges: false });
  const rebuilt = mergeBundles(saved, kbBundleFromClassroomArchive(bundleFromRaw(raw)));
  assert.deepEqual(detectClassroomChanges(rebuilt, classroom), { newCourses: [], hasChanges: false },
    "a second Update now must not resurrect the banner");
});

test("a course whose coursework fetch failed is treated the same way", async () => {
  // fetchFacetGraceful degrades to [] on an API error, so a transient failure
  // produced a note-less course too — and the same permanent banner.
  const { bundleFromRaw } = await import("../archive-builder.js");
  const { kbBundleFromClassroomArchive } = await import("../kb-client-build.js");
  const archive = bundleFromRaw({
    courses: [{ id: "c1", name: "Databázy Y3", section: "2025/26", creationTime: "2025-09-01T00:00:00Z" }],
    courseData: { c1: { topics: [], courseWork: [], courseWorkMaterials: [], announcements: [] } },
  });
  const saved = mergeBundles(null, kbBundleFromClassroomArchive(archive));
  assert.deepEqual(detectClassroomChanges(saved, [{ name: "Databázy Y3" }]), { newCourses: [], hasChanges: false });
});

test("the banner names the courses it is talking about", async () => {
  const { classroomChangesMessage } = await import("../kb.js");
  assert.equal(classroomChangesMessage(["MATURITA INFO Y4"]),
    "1 new course in Google Classroom: MATURITA INFO Y4.");
  assert.equal(classroomChangesMessage(["A", "B"]), "2 new courses in Google Classroom: A, B.");
  assert.equal(classroomChangesMessage(["A", "B", "C", "D", "E"]),
    "5 new courses in Google Classroom: A, B, C and 2 more.");
  assert.equal(classroomChangesMessage([]), "");
  assert.equal(classroomChangesMessage(null), "");
  assert.equal(classroomChangesMessage(["  ", ""]), "");
});
