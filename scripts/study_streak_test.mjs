import test from "node:test";
import assert from "node:assert/strict";
import { studyStreakModel, recordStudyActivity } from "../study-streak.js";

test("counts a consecutive study streak ending today", () => {
  const result = studyStreakModel(["2026-07-19", "2026-07-20", "2026-07-21"], "2026-07-21");
  assert.deepEqual(result, { current: 3, activeToday: true, lastDate: "2026-07-21" });
});

test("does not claim an active streak when the latest activity is older than yesterday", () => {
  const result = studyStreakModel(["2026-07-17", "2026-07-18"], "2026-07-21");
  assert.deepEqual(result, { current: 0, activeToday: false, lastDate: "2026-07-18" });
});

test("keeps yesterday's streak alive until the student returns today", () => {
  const result = studyStreakModel(["2026-07-20"], "2026-07-21");
  assert.deepEqual(result, { current: 1, activeToday: false, lastDate: "2026-07-20" });
});

test("records one local activity date without duplicates", () => {
  assert.deepEqual(recordStudyActivity(["2026-07-20"], "2026-07-21"), ["2026-07-20", "2026-07-21"]);
  assert.deepEqual(recordStudyActivity(["2026-07-21"], "2026-07-21"), ["2026-07-21"]);
});

test("ignores calendar-impossible activity dates", () => {
  assert.deepEqual(recordStudyActivity(["2026-02-28"], "2026-02-30"), ["2026-02-28"]);
  assert.deepEqual(studyStreakModel(["2026-02-30"], "2026-03-01"), { current: 0, activeToday: false, lastDate: null });
});
