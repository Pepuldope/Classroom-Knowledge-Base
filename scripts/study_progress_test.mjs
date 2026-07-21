import test from "node:test";
import assert from "node:assert/strict";
import { recordNoteProgress, studyProgressModel } from "../study-progress.js";

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
