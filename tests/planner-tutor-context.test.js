// planner-tutor-context.test.js — test for planner-tutor-context.js
//
// Written in Jest syntax (global `test`, `expect`) when it was added, in a repo
// that runs node:test — so it threw "test is not defined" on load and never
// checked anything. Same assertions, in the runner the repo actually uses.
import test from "node:test";
import assert from "node:assert/strict";
import { plannerTutorContextModel, plannerTutorSourcesText, plannerTutorCopyStatusModel } from "../planner-tutor-context.js";

test("plannerTutorContextModel returns correct structure", () => {
  const assignment = {
    title: "Test Assignment",
    courseName: "Test Course",
    materials: [{ title: "Material 1" }, { title: "Material 2" }],
  };
  assert.deepEqual(plannerTutorContextModel(assignment), {
    badge: "Grounded in this assignment",
    summary: "Test Assignment · Test Course · 2 attached materials",
    sources: ["Test Assignment", "Material 1", "Material 2"],
  });
});

test("an untitled material and a missing title still read as something", () => {
  const context = plannerTutorContextModel({ materials: [{}] });
  assert.equal(context.summary, "Assignment · 1 attached material");
  assert.deepEqual(context.sources, ["Assignment", "Attached material"]);
});

test("plannerTutorSourcesText returns formatted string", () => {
  const assignment = {
    title: "Test Assignment",
    courseName: "Test Course",
    materials: [{ title: "Material 1" }],
  };
  assert.equal(plannerTutorSourcesText(assignment),
    "Grounded in this assignment\nTest Assignment · Test Course · 1 attached material\nSources: Test Assignment · Material 1");
});

test("plannerTutorCopyStatusModel returns correct status", () => {
  assert.deepEqual(plannerTutorCopyStatusModel("idle"), { label: "Copy sources", announcement: "" });
  assert.deepEqual(plannerTutorCopyStatusModel("success"), { label: "Copied", announcement: "Grounding sources copied" });
  assert.deepEqual(plannerTutorCopyStatusModel("error"), { label: "Copy failed", announcement: "Could not copy grounding sources" });
});
