import { test } from "node:test";
import assert from "node:assert/strict";
import { kbBrowseStateModel, kbBrowseRecentEmptyStateModel, tutorThreadTitleModel } from "../kb.js";

test("kbBrowseStateModel persists and restores the selected course and year", () => {
  assert.deepEqual(kbBrowseStateModel({ course: "Math", year: "2024" }), {
    course: "Math",
    year: "2024",
  });
});

test("kbBrowseStateModel drops malformed browse selections", () => {
  assert.deepEqual(kbBrowseStateModel({ course: 42, year: null }), {
    course: "",
    year: "",
  });
});

test("recently studied empty state offers a bounded recovery action", () => {
  assert.deepEqual(kbBrowseRecentEmptyStateModel({ course: "Math", year: "2024" }), {
    message: "No notes in Math in 2024 were studied in the last 7 days.",
    actionLabel: "Show all Math notes in 2024",
    actionAriaLabel: "Show all Math notes in 2024",
    clearRecent: true,
  });
});

test("tutorThreadTitleModel normalizes a local thread title", () => {
  assert.equal(tutorThreadTitleModel("  Quadratic equations  "), "Quadratic equations");
  assert.equal(tutorThreadTitleModel(""), "New tutor thread");
  assert.equal(tutorThreadTitleModel("x".repeat(200)).length, 80);
});
