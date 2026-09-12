// archive-builder-live-shape.test.js — the parts of the Classroom build that
// had no test at all.
//
// WHY THIS FILE EXISTS
//   Before this, every gate that touched Classroom invented its own responses,
//   and three paths through buildArchiveFromClassroom had never been executed
//   by anything:
//
//     1. the list keys. /topics returns `topic`, /courseWorkMaterials returns
//        `courseWorkMaterial`, /studentSubmissions returns `studentSubmissions`.
//        Get one wrong and the facet silently yields [] — the build still
//        "succeeds", just emptier. tests/archive-builder-resume.test.js had two
//        of the three wrong and passed anyway, because it asserted on empty.
//     2. pagination. fetchAllPages loops on nextPageToken; no gate ever set
//        one, so the loop had only ever run exactly once, on any corpus.
//     3. the per-facet 403/404 skip. Archived courses deny some endpoints, and
//        the build is supposed to drop that facet rather than lose the course.
//        Only tests/kb-reconcile.test.js went near it.
//
//   These are regression gates over code that turned out to be correct, not
//   bug fixes — with one exception, noted on the statusOf test below, which was
//   a real latent break.

import test from "node:test";
import assert from "node:assert/strict";
import { buildArchiveFromClassroom } from "../archive-builder.js";

const COURSE = { id: "c1", name: "Algebra", creationTime: "2025-09-01T00:00:00Z" };

/**
 * A gFetch built from a route table, so each test states only what it cares
 * about. Anything unrouted throws — a stub that quietly answers a request the
 * build did not expect is how the list-key bug survived.
 */
function fakeFetch(routes, { log = [] } = {}) {
  return async (url) => {
    log.push(url);
    for (const [match, respond] of routes) {
      if (url.includes(match)) return typeof respond === "function" ? respond(url) : respond;
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
}

/** An error shaped the way app.js gFetch shapes one. */
function classroomError(status, message = `Classroom API ${status}: denied`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// 1. List keys
// ---------------------------------------------------------------------------

test("the real Classroom list keys are what the build reads", async () => {
  const bundle = await buildArchiveFromClassroom(fakeFetch([
    ["/courses?", { courses: [COURSE] }],
    // Singular on purpose: this is what Google returns, and it is the exact
    // character a hand-written stub drops.
    ["/topics", { topic: [{ topicId: "t1", name: "Quadratics" }] }],
    ["/courseWork?", { courseWork: [{ id: "w1", title: "Factorising", topicId: "t1" }] }],
    ["/courseWorkMaterials", { courseWorkMaterial: [{ id: "m1", title: "Worked examples", topicId: "t1" }] }],
    ["/announcements", { announcements: [{ id: "a1", text: "Test Friday", creationTime: "2025-09-10T00:00:00Z" }] }],
    ["/studentSubmissions", { studentSubmissions: [{ courseWorkId: "w1", state: "TURNED_IN" }] }],
  ]));

  // One coursework note, one material note, one announcements note.
  assert.equal(bundle.notes.length, 3);
  assert.ok(bundle.notes.some((n) => n.t === "Factorising"), "coursework note missing");
  assert.ok(bundle.notes.some((n) => n.t === "Worked examples"), "courseWorkMaterial note missing — list key read as plural?");
  assert.ok(bundle.notes.some((n) => n.topic === "Quadratics"), "topic never reached the note — /topics read as plural?");
});

test("plural list keys yield nothing, which is why the trap is silent", async () => {
  const bundle = await buildArchiveFromClassroom(fakeFetch([
    ["/courses?", { courses: [COURSE] }],
    // Every one of these is the wrong key. The build must not throw — it just
    // quietly produces an emptier archive, which is the failure mode.
    ["/topics", { topics: [{ topicId: "t1", name: "Quadratics" }] }],
    ["/courseWork?", { courseWork: [{ id: "w1", title: "Factorising" }] }],
    ["/courseWorkMaterials", { courseWorkMaterials: [{ id: "m1", title: "Worked examples" }] }],
    ["/announcements", { announcements: [] }],
    ["/studentSubmissions", { submissions: [{ courseWorkId: "w1", state: "TURNED_IN" }] }],
  ]));

  assert.equal(bundle.notes.length, 1, "only the one correctly-keyed facet should survive");
  assert.equal(bundle.notes[0].t, "Factorising");
  // This is the whole reason the trap is silent: the topic does not come back
  // empty and obviously wrong, it comes back "Uncategorized" — indistinguishable
  // from a course that genuinely has no topics set.
  assert.equal(bundle.notes[0].topic, "Uncategorized", "a mis-keyed /topics should fall back, not invent a real topic name");
});

// ---------------------------------------------------------------------------
// 2. Pagination
// ---------------------------------------------------------------------------

test("the courses list is followed across pages", async () => {
  const log = [];
  const bundle = await buildArchiveFromClassroom(fakeFetch([
    ["/courses?", (url) => (url.includes("pageToken=p2")
      ? { courses: [{ id: "c2", name: "Physics", creationTime: "2025-09-01T00:00:00Z" }] }
      : { courses: [COURSE], nextPageToken: "p2" })],
    ["/topics", { topic: [] }],
    ["/courseWork?", (url) => ({ courseWork: [{ id: `w-${url.includes("c2") ? "c2" : "c1"}`, title: url.includes("c2") ? "Motion" : "Factorising" }] })],
    ["/courseWorkMaterials", { courseWorkMaterial: [] }],
    ["/announcements", { announcements: [] }],
    ["/studentSubmissions", { studentSubmissions: [] }],
  ], { log }));

  assert.equal(bundle.courses.length, 2, "second page of courses was dropped");
  assert.equal(log.filter((u) => u.includes("/courses?")).length, 2);
  assert.ok(log.some((u) => u.includes("pageToken=p2")), "nextPageToken was never followed");
});

test("a facet is followed across pages", async () => {
  const log = [];
  const bundle = await buildArchiveFromClassroom(fakeFetch([
    ["/courses?", { courses: [COURSE] }],
    ["/topics", { topic: [] }],
    ["/courseWork?", (url) => (url.includes("pageToken=cw2")
      ? { courseWork: [{ id: "w2", title: "Completing the square" }] }
      : { courseWork: [{ id: "w1", title: "Factorising" }], nextPageToken: "cw2" })],
    ["/courseWorkMaterials", { courseWorkMaterial: [] }],
    ["/announcements", { announcements: [] }],
    ["/studentSubmissions", { studentSubmissions: [] }],
  ], { log }));

  assert.equal(bundle.notes.length, 2, "second page of coursework was dropped");
  assert.ok(log.some((u) => u.includes("pageToken=cw2")), "facet nextPageToken was never followed");
});

// ---------------------------------------------------------------------------
// 3. Per-facet 403/404
// ---------------------------------------------------------------------------

test("a denied facet is skipped, and the course survives with the rest", async () => {
  const messages = [];
  const bundle = await buildArchiveFromClassroom(fakeFetch([
    ["/courses?", { courses: [COURSE] }],
    ["/topics", { topic: [] }],
    ["/courseWork?", { courseWork: [{ id: "w1", title: "Factorising" }] }],
    // An archived course commonly denies this one.
    ["/courseWorkMaterials", () => { throw classroomError(403); }],
    ["/announcements", { announcements: [] }],
    ["/studentSubmissions", { studentSubmissions: [] }],
  ]), { onProgress: (p) => messages.push(p.message) });

  assert.equal(bundle.notes.length, 1, "the denied facet should not cost the whole course");
  assert.ok(
    messages.some((m) => /1 endpoint skipped/.test(m)),
    `the skip should be reported to the student; got: ${JSON.stringify(messages.at(-1))}`,
  );
});

test("a 404 facet is skipped the same way as a 403", async () => {
  const bundle = await buildArchiveFromClassroom(fakeFetch([
    ["/courses?", { courses: [COURSE] }],
    ["/topics", () => { throw classroomError(404); }],
    ["/courseWork?", { courseWork: [{ id: "w1", title: "Factorising" }] }],
    ["/courseWorkMaterials", { courseWorkMaterial: [] }],
    ["/announcements", { announcements: [] }],
    ["/studentSubmissions", { studentSubmissions: [] }],
  ]));

  assert.equal(bundle.notes.length, 1);
});

test("a 500 is not swallowed — the course is skipped, not silently emptied", async () => {
  const messages = [];
  const bundle = await buildArchiveFromClassroom(fakeFetch([
    ["/courses?", { courses: [COURSE] }],
    ["/topics", { topic: [] }],
    ["/courseWork?", () => { throw classroomError(500); }],
    ["/courseWorkMaterials", { courseWorkMaterial: [] }],
    ["/announcements", { announcements: [] }],
    ["/studentSubmissions", { studentSubmissions: [] }],
  ]), { onProgress: (p) => messages.push(p.message) });

  assert.equal(bundle.notes.length, 0);
  assert.ok(
    messages.some((m) => /Skipping course/.test(m)),
    "a server error should skip the course loudly, not degrade to an empty facet",
  );
});

// RED before the fix. statusOf() read the status out of the error *message*
// only, although both throwers (app.js gFetch and api/kb-scrape.js) also set
// `err.status`. Any reword of that message — or any other caller raising a
// structured error — turned a facet that should be skipped into a 500-shaped
// failure that loses the entire course. The message is the fallback now, not
// the source of truth.
test("a denied facet is skipped on err.status even when the message is reworded", async () => {
  const bundle = await buildArchiveFromClassroom(fakeFetch([
    ["/courses?", { courses: [COURSE] }],
    ["/topics", { topic: [] }],
    ["/courseWork?", { courseWork: [{ id: "w1", title: "Factorising" }] }],
    ["/courseWorkMaterials", () => { throw classroomError(403, "Request failed with status 403"); }],
    ["/announcements", { announcements: [] }],
    ["/studentSubmissions", { studentSubmissions: [] }],
  ]));

  assert.equal(bundle.notes.length, 1, "the course was lost because the status was only readable from the message");
});
