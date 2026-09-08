// The Curriculum matrix files a course under `note.y`, so a wrong year here is
// a course sitting in the wrong column. Two of the owner's own courses did.
import test from "node:test";
import assert from "node:assert/strict";
import { schoolYearOf, schoolYearFromSection, courseSchoolYear } from "../archive-builder.js";
import { bundleFromRaw } from "../archive-builder.js";

test("a stated section beats the creation date", () => {
  // The real regression: created 1 July 2025, section says 2025/26. The old
  // August boundary filed it as 2024-25 — one column to the left.
  assert.equal(
    courseSchoolYear({ name: "NaE Y3 3.T", section: "2025/26", creationTime: "2025-07-01T12:31:18.847Z" }),
    "2025-26",
  );
  // Created 18 June, i.e. before any month boundary would help; only the
  // section gets this one right.
  assert.equal(
    courseSchoolYear({ name: "MATURITA INFO Y4", section: "2026/2027", creationTime: "2026-06-18T08:59:57.111Z" }),
    "2026-27",
  );
});

test("section formats: slash, dash, and a four-digit end year", () => {
  assert.equal(schoolYearFromSection("2025/26"), "2025-26");
  assert.equal(schoolYearFromSection("2026/2027"), "2026-27");
  assert.equal(schoolYearFromSection("2023-24"), "2023-24");
});

test("a graduating cohort is not a school year", () => {
  // "Class 2027" and "Stáže - class of 2027" are real course sections in the
  // owner's Classroom. Matching them would file whole courses years away.
  assert.equal(schoolYearFromSection("Class 2027"), null);
  assert.equal(schoolYearFromSection("Stáže - class of 2027"), null);
  assert.equal(schoolYearFromSection(""), null);
  assert.equal(schoolYearFromSection(null), null);
  // Non-consecutive years are a range of something else, not a school year.
  assert.equal(schoolYearFromSection("2020/25"), null);
});

test("the creation date is still the fallback, with a July boundary", () => {
  assert.equal(schoolYearOf("2025-09-21T07:44:24.122Z"), "2025-26");
  assert.equal(schoolYearOf("2025-07-01T00:00:00.000Z"), "2025-26");
  assert.equal(schoolYearOf("2025-06-30T00:00:00.000Z"), "2024-25");
  // No section, no year in the name -> inference is all there is.
  assert.equal(courseSchoolYear({ name: "Budúcnosť po Lýceu", section: "Class 2027", creationTime: "2026-02-23T11:07:45.340Z" }), "2025-26");
});

test("bundleFromRaw files notes and courses under the resolved year", () => {
  const bundle = bundleFromRaw({
    courses: [{ id: "c1", name: "NaE Y3 3.T", section: "2025/26", creationTime: "2025-07-01T12:31:18.847Z" }],
    courseData: { c1: { topics: [{ topicId: "t1", name: "Sprint 1" }], courseWork: [{ id: "w1", title: "Pitch", topicId: "t1" }] } },
  });
  assert.equal(bundle.notes[0].y, "2025-26");
  assert.equal(bundle.courses[0].y, "2025-26");
  assert.deepEqual(bundle.years, ["2025-26"]);
  assert.ok(bundle.notes[0].p.startsWith("2025-26/"), bundle.notes[0].p);
});
