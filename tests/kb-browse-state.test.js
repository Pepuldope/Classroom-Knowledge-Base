import { test } from "node:test";
import assert from "node:assert/strict";
import {
  kbBrowseStateModel,
  kbBrowseRecentEmptyStateModel,
  tutorThreadTitleModel,
  tutorThreadArchiveModel,
  tutorThreadDeleteModel,
  tutorThreadRestoreModel,
} from "../kb.js";

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

test("tutorThreadArchiveModel keeps bounded local thread records and drops malformed entries", () => {
  assert.deepEqual(tutorThreadArchiveModel([
    { id: "t1", title: "  Algebra  ", messages: [{ role: "user", content: "Explain roots" }], archivedAt: 12 },
    { id: "", title: "bad", messages: [] },
    { id: "t2", title: "Other", messages: [{ role: "assistant", content: "Answer" }], archivedAt: "nope" },
  ]), [
    { id: "t1", title: "Algebra", messages: [{ role: "user", content: "Explain roots" }], archivedAt: 12 },
    { id: "t2", title: "Other", messages: [{ role: "assistant", content: "Answer" }], archivedAt: 0 },
  ]);
});

test("tutorThreadDeleteModel removes only the requested local thread", () => {
  const threads = [{ id: "t1", title: "One", messages: [], archivedAt: 1 }, { id: "t2", title: "Two", messages: [], archivedAt: 2 }];
  assert.deepEqual(tutorThreadDeleteModel(threads, "t1"), [threads[1]]);
  assert.deepEqual(tutorThreadDeleteModel(threads, "missing"), threads);
});

test("tutorThreadRestoreModel returns one normalized archived thread by id", () => {
  const threads = [
    { id: "t1", title: "  Algebra  ", messages: [{ role: "user", content: " Explain roots " }], archivedAt: 1 },
    { id: "t2", title: "Other", messages: [], archivedAt: 2 },
  ];
  assert.deepEqual(tutorThreadRestoreModel(threads, "t1"), {
    id: "t1",
    title: "Algebra",
    messages: [{ role: "user", content: "Explain roots" }],
    archivedAt: 1,
  });
  assert.equal(tutorThreadRestoreModel(threads, "missing"), null);
  const longId = "x".repeat(90);
  assert.equal(tutorThreadRestoreModel([{ id: longId, title: "Long", messages: [] }], longId)?.id, "x".repeat(80));
});
