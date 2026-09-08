import { test } from "node:test";
import assert from "node:assert/strict";
import {
  kbBrowseStateModel,
  kbBrowseIsDefault,
  kbBrowseRecentEmptyStateModel,
  tutorThreadTitleModel,
  tutorThreadArchiveModel,
  tutorThreadDeleteModel,
  tutorThreadRestoreModel,
  noteModalAnnouncementModel,
} from "../kb.js";

const BROWSE_DEFAULTS = { course: "", year: "", family: "", topic: "", q: "", gridSort: "notes", noteSort: "recency", recent: false };

test("kbBrowseStateModel persists and restores the selected course and year", () => {
  assert.deepEqual(kbBrowseStateModel({ course: "Math", year: "2024" }), {
    ...BROWSE_DEFAULTS,
    course: "Math",
    year: "2024",
  });
});

test("kbBrowseStateModel drops malformed browse selections", () => {
  assert.deepEqual(kbBrowseStateModel({ course: 42, year: null }), BROWSE_DEFAULTS);
});

test("kbBrowseStateModel keeps the whole filter set and rejects unknown sorts", () => {
  assert.deepEqual(
    kbBrowseStateModel({ course: " Math ", year: "2024-25", family: "Science/Math", topic: " Sprint 1 ", q: " roots ", gridSort: "recent", noteSort: "title", recent: true }),
    { course: "Math", year: "2024-25", family: "Science/Math", topic: "Sprint 1", q: "roots", gridSort: "recent", noteSort: "title", recent: true },
  );
  // An unknown sort must not reach makeSortFn or the <select>.
  assert.equal(kbBrowseStateModel({ gridSort: "sideways", noteSort: "sideways" }).gridSort, "notes");
  assert.equal(kbBrowseStateModel({ gridSort: "sideways", noteSort: "sideways" }).noteSort, "recency");
  // "recent" is a checkbox, not a truthy string.
  assert.equal(kbBrowseStateModel({ recent: "yes" }).recent, false);
});

test("kbBrowseIsDefault only counts the filters the current view actually shows", () => {
  assert.equal(kbBrowseIsDefault({}), true);
  assert.equal(kbBrowseIsDefault({}, { inCourse: true }), true);
  // A course being open is not itself a filter.
  assert.equal(kbBrowseIsDefault({ course: "Math" }, { inCourse: true }), true);
  // Year is corpus-wide: it counts in both views.
  assert.equal(kbBrowseIsDefault({ year: "2024-25" }), false);
  assert.equal(kbBrowseIsDefault({ year: "2024-25" }, { inCourse: true }), false);
  // Type is a grid-only control; topic and "recent" are course-only.
  assert.equal(kbBrowseIsDefault({ family: "Science/Math" }), false);
  assert.equal(kbBrowseIsDefault({ family: "Science/Math" }, { inCourse: true }), true);
  assert.equal(kbBrowseIsDefault({ topic: "Sprint 1" }, { inCourse: true }), false);
  assert.equal(kbBrowseIsDefault({ topic: "Sprint 1" }), true);
  assert.equal(kbBrowseIsDefault({ recent: true }, { inCourse: true }), false);
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

test("KB view transition returns focus to Planner after closing a modal", async () => {
  const { kbViewTransitionFocusTargetModel } = await import("../kb.js");
  assert.equal(kbViewTransitionFocusTargetModel({ from: "kb", to: "planner", modalWasOpen: true }), "planner");
  assert.equal(kbViewTransitionFocusTargetModel({ from: "kb", to: "planner", modalWasOpen: false }), null);
  assert.equal(kbViewTransitionFocusTargetModel({ from: "kb", to: "archive", modalWasOpen: true }), "archive");
});

test("route transition focus hint is bounded and does not expose note content", async () => {
  const { kbViewTransitionFocusAnnouncementModel } = await import("../kb.js");
  assert.deepEqual(kbViewTransitionFocusAnnouncementModel("planner"), {
    role: "status",
    live: "polite",
    atomic: "true",
    text: "Planner view opened. Focus restored to Planner navigation.",
  });
  assert.deepEqual(kbViewTransitionFocusAnnouncementModel("archive"), {
    role: "status",
    live: "polite",
    atomic: "true",
    text: "Archive view opened. Focus restored to Archive navigation.",
  });
  assert.equal(kbViewTransitionFocusAnnouncementModel("kb"), null);
});

test("note modal close restores the originating result focus target when it is still connected", async () => {
  const { noteModalFocusTargetModel } = await import("../kb.js");
  assert.equal(noteModalFocusTargetModel({ origin: "kb-result-12", connected: true }), "kb-result-12");
  assert.equal(noteModalFocusTargetModel({ origin: "kb-result-12", connected: false }), null);
  assert.equal(noteModalFocusTargetModel({ origin: "", connected: true }), null);
});

test("note modal announcement exposes state without including note body text", () => {
  assert.deepEqual(noteModalAnnouncementModel("open", "  Quadratic equations  "), {
    role: "status",
    live: "polite",
    atomic: "true",
    text: "Opened note: Quadratic equations.",
  });
  assert.deepEqual(noteModalAnnouncementModel("close"), {
    role: "status",
    live: "polite",
    atomic: "true",
    text: "Note closed.",
  });
  assert.deepEqual(noteModalAnnouncementModel("error"), {
    role: "status",
    live: "polite",
    atomic: "true",
    text: "Note could not be loaded.",
  });
  const longTitle = "Visible title " + "x".repeat(200);
  assert.equal(noteModalAnnouncementModel("open", longTitle).text.length <= 180, true);
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
