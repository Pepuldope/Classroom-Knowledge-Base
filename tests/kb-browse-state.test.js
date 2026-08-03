import { test } from "node:test";
import assert from "node:assert/strict";
import { kbBrowseStateModel } from "../kb.js";

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
