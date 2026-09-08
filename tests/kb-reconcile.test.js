// Reconciling the corpus against a Classroom build.
//
// Merging alone never removed anything. That is right for past years imported
// from a School Backup export — Classroom no longer serves them — and wrong for
// a course the build just read end to end: a deleted assignment lingered
// forever, and a renamed one appeared twice, once under each title.
import test from "node:test";
import assert from "node:assert/strict";
import { bundleFromRaw } from "../archive-builder.js";
import { kbBundleFromClassroomArchive } from "../kb-client-build.js";
import { mergeBundles } from "../kb-merge.js";

const COURSE = { id: "c1", name: "NaE Y3 3.T", section: "2025/26", creationTime: "2025-07-01T00:00:00Z" };

/** One Classroom build of one course. `covered` is what fetched cleanly. */
function build(courseWork, { covered = ["c1"], course = COURSE } = {}) {
  return kbBundleFromClassroomArchive(bundleFromRaw({
    courses: [course],
    coveredCourseIds: covered,
    courseData: { [course.id]: { topics: [{ topicId: "t1", name: "Sprint 1" }], courseWork } },
  }));
}
const titles = (bundle) => bundle.notes.map((n) => n.t).sort();

test("an assignment the teacher deleted stops being in the corpus", () => {
  let stored = mergeBundles(null, build([
    { id: "w1", title: "Pitch", topicId: "t1" },
    { id: "w2", title: "Reflection", topicId: "t1" },
  ]));
  assert.deepEqual(titles(stored), ["Pitch", "Reflection"]);

  stored = mergeBundles(stored, build([{ id: "w1", title: "Pitch", topicId: "t1" }]));
  assert.deepEqual(titles(stored), ["Pitch"]);
  assert.equal(stored.prunedCount, 1);
});

test("a renamed assignment moves rather than duplicating", () => {
  // The note path carries the title, so a rename produces a brand-new path.
  let stored = mergeBundles(null, build([{ id: "w1", title: "Pitch", topicId: "t1" }]));
  stored = mergeBundles(stored, build([{ id: "w1", title: "Final pitch", topicId: "t1" }]));
  assert.deepEqual(titles(stored), ["Final pitch"]);
});

test("changed attachments update the note in place", () => {
  // This case always worked: the path is unchanged, so the incoming note wins.
  const withMaterials = (mats) => build([{ id: "w1", title: "Pitch", topicId: "t1", materials: mats }]);
  let stored = mergeBundles(null, withMaterials([
    { link: { url: "http://a", title: "Slides A" } },
    { link: { url: "http://b", title: "Slides B" } },
  ]));
  stored = mergeBundles(stored, withMaterials([
    { link: { url: "http://a", title: "Slides A" } },
    { link: { url: "http://c", title: "Slides C" } },
  ]));
  assert.equal(stored.notes.length, 1);
  const body = stored.notes[0].x;
  assert.ok(!/Slides B/.test(body), "the removed attachment is gone from the note");
  assert.ok(/Slides C/.test(body), "the new attachment is in the note");
});

test("a course whose fetch failed deletes nothing", () => {
  // fetchFacetGraceful degrades a 403 to an empty list. Without the coverage
  // guard, one transient failure would wipe that course from the corpus.
  let stored = mergeBundles(null, build([{ id: "w1", title: "Pitch", topicId: "t1" }]));
  const failedRun = build([], { covered: [] });
  stored = mergeBundles(stored, failedRun);
  assert.deepEqual(titles(stored), ["Pitch"], "notes survive a failed fetch");
  assert.equal(stored.prunedCount, undefined);
});

test("a course legitimately emptied IS reconciled", () => {
  // Same empty result, but the course fetched cleanly — so it really is empty.
  let stored = mergeBundles(null, build([{ id: "w1", title: "Pitch", topicId: "t1" }]));
  stored = mergeBundles(stored, build([], { covered: ["c1"] }));
  assert.deepEqual(titles(stored), []);
});

test("imported past years are never touched", () => {
  // An import carries no coverage, and a Classroom build's coverage never names
  // a course it did not read.
  const imported = {
    version: 1,
    notes: [
      { p: "2019-20/vault/Old Course/T/Essay", t: "Essay", course: "Old Course", y: "2019-20" },
      { p: "2019-20/vault/Old Course/T/Report", t: "Report", course: "Old Course", y: "2019-20" },
    ],
  };
  const merged = mergeBundles(imported, build([{ id: "w1", title: "Pitch", topicId: "t1" }]));
  assert.deepEqual(titles(merged), ["Essay", "Pitch", "Report"]);

  // And importing on top of a build prunes nothing either.
  const back = mergeBundles(merged, imported);
  assert.deepEqual(titles(back), ["Essay", "Pitch", "Report"]);
});

test("reconciliation follows a course rename via its Classroom id", () => {
  let stored = mergeBundles(null, build([{ id: "w1", title: "Pitch", topicId: "t1" }]));
  assert.equal(stored.notes[0].cid, "c1", "notes carry the course id they came from");
  const renamed = { ...COURSE, name: "NaE Y3 (3.T)" };
  stored = mergeBundles(stored, build([{ id: "w1", title: "Pitch", topicId: "t1" }], { course: renamed }));
  assert.equal(stored.notes.length, 1, "the course renaming must not double the corpus");
  assert.equal(stored.notes[0].course, "NaE Y3 (3.T)");
});

test("notes with no course id fall back to course-and-year scope", () => {
  // Anything stored before course ids were recorded.
  const legacy = {
    version: 1,
    notes: [{ p: "2025-26/vault/NaE Y3 3.T/Sprint 1/Gone", t: "Gone", course: "NaE Y3 3.T", y: "2025-26" }],
  };
  const merged = mergeBundles(legacy, build([{ id: "w1", title: "Pitch", topicId: "t1" }]));
  assert.deepEqual(titles(merged), ["Pitch"], "a legacy note in a covered course-year is reconciled too");
});
