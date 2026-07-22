import test from "node:test";
import assert from "node:assert/strict";
import { recordNoteProgress, studyProgressModel, studyProgressCopy } from "../study-progress.js";

test("records a note as opened without duplicates", () => {
  const next = recordNoteProgress({}, "12", "2026-07-21");
  assert.deepEqual(next, { "12": { opened: 1, lastOpened: "2026-07-21" } });
  assert.deepEqual(recordNoteProgress(next, 12, "2026-07-21"), next);
});

test("ignores invalid note ids and dates", () => {
  assert.deepEqual(recordNoteProgress({ "2": { opened: 1, lastOpened: "2026-07-20" } }, "bad", "2026-07-21"), {
    "2": { opened: 1, lastOpened: "2026-07-20" },
  });
});

test("summarizes valid progress for a bundle", () => {
  const result = studyProgressModel({
    "1": { opened: 2, lastOpened: "2026-07-21" },
    "2": { opened: 1, lastOpened: "2026-07-20" },
    bad: { opened: 99 },
  }, 5);
  assert.deepEqual(result, { openedNotes: 2, totalNotes: 5, percent: 40, lastOpened: "2026-07-21" });
});

test("explains when local progress has no bundle to measure yet", () => {
  assert.deepEqual(studyProgressCopy(studyProgressModel({}, 0)), {
    headline: "📖 Start exploring",
    detail: "Open a note from your local knowledge base to track progress here.",
  });
});

test("keeps the progress copy useful for a populated bundle", () => {
  assert.deepEqual(studyProgressCopy(studyProgressModel({ "1": { opened: 1, lastOpened: "2026-07-21" } }, 4)), {
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
