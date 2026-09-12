// archive-builder-fixture.test.js — run the real builder over the real shapes.
//
// tests/archive-builder-live-shape.test.js pins the ingest path against shapes
// written by hand from the API reference. This one runs it over
// tests/fixtures/classroom/, which is a redacted snapshot of what Google
// actually returned for a real account — the difference being that a snapshot
// contains the fields, orderings and empty-vs-absent distinctions nobody thought
// to write down.
//
// It SKIPS until a capture exists. To create one:
//   1. sign in on https://classroom-knowledge.vercel.app
//   2. paste scripts/capture-classroom.js into devtools, run `await captureClassroom()`
//   3. save the payload as scratchpad/_classroom-raw.json  (gitignored)
//   4. node scripts/redact-classroom.mjs scratchpad/_classroom-raw.json
//   5. node --test tests/fixtures-privacy.test.js     (must pass before committing)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { buildArchiveFromClassroom } from "../archive-builder.js";

const DIR = process.env.KB_FIXTURE_DIR || "tests/fixtures/classroom";
const present = ["courses.json", "course-data.json", "manifest.json"]
  .every((f) => existsSync(`${DIR}/${f}`));
const skip = !present && `${DIR} not captured yet — see the header of this file`;

const load = (f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));

/**
 * Serve the fixtures as the Classroom API would, list keys and all.
 *
 * Deliberately keyed off the same URL fragments archive-builder.js builds, so a
 * change to those URLs shows up here as an unrouted fetch rather than as a
 * quietly empty facet.
 */
function fixtureFetch(courses, courseData, { log = [] } = {}) {
  return async (url) => {
    log.push(url);
    if (url.includes("/courses?")) return { courses };
    const course = Object.keys(courseData).find((id) => url.includes(`/courses/${id}/`));
    if (!course) throw new Error(`unrouted fetch: ${url}`);
    const f = courseData[course];
    if (url.includes("studentSubmissions")) return { studentSubmissions: f.submissions || [] };
    if (url.includes("courseWorkMaterials")) return { courseWorkMaterial: f.courseWorkMaterials || [] };
    if (url.includes("/courseWork?")) return { courseWork: f.courseWork || [] };
    if (url.includes("/topics")) return { topic: f.topics || [] };
    if (url.includes("/announcements")) return { announcements: f.announcements || [] };
    throw new Error(`unrouted fetch: ${url}`);
  };
}

test("the builder produces a usable bundle from the real captured shapes", { skip }, async () => {
  const courses = load("courses.json");
  const courseData = load("course-data.json");
  const log = [];
  const bundle = await buildArchiveFromClassroom(fixtureFetch(courses, courseData, { log }));

  assert.ok(bundle.notes.length > 0, "real shapes produced no notes at all");
  assert.equal(bundle.source, "classroom");
  assert.ok(bundle.courses.length > 0, "no course facet");
  assert.ok(bundle.years.length > 0, "no year facet — check schoolYearOf/courseSchoolYear");

  // Six requests per course, one for the course list.
  const expected = 1 + courses.length * 5;
  assert.equal(log.length, expected, `expected ${expected} requests, saw ${log.length}`);
});

test("every note from the real shapes is usable as a study note", { skip }, async () => {
  const bundle = await buildArchiveFromClassroom(
    fixtureFetch(load("courses.json"), load("course-data.json")),
  );

  for (const note of bundle.notes) {
    assert.ok(note.t && note.t.trim() !== "", `note has no title: ${JSON.stringify(note).slice(0, 120)}`);
    assert.ok(note.course && note.course.trim() !== "", `note "${note.t}" has no course`);
    assert.ok(note.y, `note "${note.t}" has no school year`);
    assert.ok(note.kind, `note "${note.t}" has no kind`);
    assert.ok(typeof note.p === "string" && note.p !== "", `note "${note.t}" has no path`);
    // The ×3 summary weight in search only fires when `s` is present, and the KB
    // is supposed to SYNTHESIZE it rather than inherit it. The Classroom path
    // hardcoded `s: null` until it was fixed alongside this gate; deriveSummary
    // always returns something, so there is no excuse for an empty one.
    assert.ok(
      typeof note.s === "string" && note.s.trim() !== "",
      `note "${note.t}" has no derived summary — the ×3 search weight cannot fire`,
    );
  }
});

test("the bundle's facet counts line up with what was captured", { skip }, async () => {
  const manifest = load("manifest.json");
  const courseData = load("course-data.json");
  const bundle = await buildArchiveFromClassroom(fixtureFetch(load("courses.json"), courseData));

  // One note per coursework, one per courseWorkMaterial, and one announcements
  // note per course that has any announcements at all.
  let expected = 0;
  for (const facets of Object.values(courseData)) {
    expected += (facets.courseWork || []).length;
    expected += (facets.courseWorkMaterials || []).length;
    if ((facets.announcements || []).length > 0) expected += 1;
  }
  assert.equal(bundle.notes.length, expected, "note count does not match the captured facets");
  assert.equal(Object.keys(courseData).length, manifest.courseCount);
});
