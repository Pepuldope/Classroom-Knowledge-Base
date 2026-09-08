import test from "node:test";
import assert from "node:assert/strict";
import { recordNoteProgress, studyProgressModel, studyProgressCopy, migrateNoteProgress } from "../study-progress.js";

test("records a note as opened without duplicates", () => {
  // Keys are note paths now, not array indices — see study-progress.js.
  const note = { p: "2025-26/vault/Math/Algebra/Quadratics", t: "Quadratics" };
  const next = recordNoteProgress({}, note, "2026-07-21");
  assert.deepEqual(next, { "2025-26/vault/Math/Algebra/Quadratics": { opened: 1, lastOpened: "2026-07-21" } });
  assert.deepEqual(recordNoteProgress(next, note, "2026-07-21"), next);
});

test("ignores unidentifiable notes and invalid dates", () => {
  const existing = { "y/c/2": { opened: 1, lastOpened: "2026-07-20" } };
  const note = { p: "y/c/3", t: "Other" };
  // A note with neither a path nor a title cannot be keyed.
  assert.deepEqual(recordNoteProgress(existing, {}, "2026-07-21"), existing);
  assert.deepEqual(recordNoteProgress(existing, null, "2026-07-21"), existing);
  // A malformed date is still rejected.
  assert.deepEqual(recordNoteProgress(existing, note, "21/07/2026"), existing);
  assert.deepEqual(recordNoteProgress(existing, note, ""), existing);
});

test("entries for notes outside the corpus are pruned, not counted", () => {
  // The numeric-id rule used to do this filtering by accident; it is explicit
  // now, and checked against the actual notes rather than the key's shape.
  const notes = [{ p: "y/c/1", t: "Kept" }];
  assert.deepEqual(
    migrateNoteProgress({ "y/c/1": { opened: 1, lastOpened: "2026-07-21" }, "y/c/gone": { opened: 9 } }, notes),
    { "y/c/1": { opened: 1, lastOpened: "2026-07-21" } },
  );
});

test("summarizes valid progress for a bundle", () => {
  const result = studyProgressModel({
    "y/c/1": { opened: 2, lastOpened: "2026-07-21" },
    "y/c/2": { opened: 1, lastOpened: "2026-07-20" },
    "": { opened: 99 },
  }, 5);
  // The empty key is dropped; the two real notes count. Whether a key refers to
  // a note that still exists is migrateNoteProgress's job, not this model's.
  assert.deepEqual(result, { openedNotes: 2, totalNotes: 5, percent: 40, lastOpened: "2026-07-21" });
});

test("explains when local progress has no bundle to measure yet", () => {
  assert.deepEqual(studyProgressCopy(studyProgressModel({}, 0)), {
    headline: "📖 Start exploring",
    detail: "Open a note from your local knowledge base to track progress here.",
  });
});

test("keeps the progress copy useful for a populated bundle", () => {
  assert.deepEqual(studyProgressCopy(studyProgressModel({ "y/c/1": { opened: 1, lastOpened: "2026-07-21" } }, 4)), {
    headline: "📖 25% explored",
    detail: "1 of 4 notes opened · last opened 2026-07-21",
  });
});

test("treats an incomplete progress summary as empty local progress", () => {
  assert.deepEqual(studyProgressCopy({}), {
    headline: "📖 Start exploring",
    detail: "Open a note from your local knowledge base to track progress here.",
  });
});
