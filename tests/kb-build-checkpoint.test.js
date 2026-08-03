import test from "node:test";
import assert from "node:assert/strict";
import { kbBuildCheckpointModel, kbBuildResumeSummaryModel } from "../kb-local-status.js";

test("checkpoint model keeps only resumable course data and hides the rebuild card", () => {
  const checkpoint = kbBuildCheckpointModel({
    courses: [{ id: "c1", name: "Algebra" }, { id: "c2", name: "Physics" }],
    courseData: { c1: { courseWork: [{ id: "a1" }] } },
  });

  assert.deepEqual(checkpoint, {
    version: 1,
    courses: [{ id: "c1", name: "Algebra" }, { id: "c2", name: "Physics" }],
    courseData: { c1: { courseWork: [{ id: "a1" }] } },
    completedCourseIds: ["c1"],
    showBuildCard: false,
  });
  assert.equal("token" in checkpoint, false);
});

test("resume summary names a bounded set of completed courses without exposing course contents", () => {
  assert.deepEqual(kbBuildResumeSummaryModel({
    courses: [
      { id: "c1", name: "Algebra" },
      { id: "c2", name: "Physics" },
      { id: "c3", name: "History" },
      { id: "c4", name: "Biology" },
    ],
    courseData: {
      c1: { courseWork: [{ title: "private assignment" }] },
      c2: { courseWork: [] },
      c3: { courseWork: [] },
    },
  }), {
    completed: 3,
    total: 4,
    names: ["Algebra", "Physics", "History"],
    remaining: 1,
    label: "Completed 3 of 4 courses: Algebra, Physics, History (+1 more).",
  });
});

test("checkpoint model treats malformed or empty checkpoints as no resumable build", () => {
  assert.deepEqual(kbBuildCheckpointModel(null), {
    version: 1,
    courses: [],
    courseData: {},
    completedCourseIds: [],
    showBuildCard: true,
  });
});
