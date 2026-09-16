// Where the work happens, and what the work is — two questions, two answers.
//
// Peter, 2026-09-16: "It miscategorized a worksheet homework as a test."
//
// One keyword list used to answer both. Anything on it — "test", but equally
// "na hodine", "in class", "lab demo" — marked an assignment as done in person,
// which is right, and then forced the kind, whose else-branch was "Test". A
// worksheet that said it would be done in class came back as a Test, and a test
// the student did not have appeared on the Planner.
import test from "node:test";
import assert from "node:assert/strict";
import { inPersonDecision } from "../api/enrich.js";

test("a place word says where, never what", () => {
  const worksheet = { title: "Worksheet 4 - fractions", desc: "Vypracujte na hodine.", taskKind: "Worksheet" };
  assert.deepEqual(inPersonDecision(worksheet), { actionType: "in_person" },
    "a worksheet done in class is a worksheet done in class");
  assert.deepEqual(inPersonDecision({ title: "Reading log", desc: "We will do this in class.", taskKind: "Reading" }),
    { actionType: "in_person" });
});

test("a description mentioning an assessment is usually mentioning a different one", () => {
  // The single most ordinary sentence on a homework worksheet.
  assert.deepEqual(
    inPersonDecision({ title: "Homework 3", desc: "Prepare for the test on Friday.", taskKind: "Worksheet" }),
    { actionType: "in_person" },
    "revision homework was relabelled as the test it is revision for",
  );
});

test("an assessment named in the title still wins", () => {
  assert.deepEqual(inPersonDecision({ title: "Písomka - stereometria", desc: "", taskKind: "Worksheet" }),
    { actionType: "in_person", taskKind: "Test" });
  assert.deepEqual(inPersonDecision({ title: "Vocabulary quiz", desc: "", taskKind: "Worksheet" }),
    { actionType: "in_person", taskKind: "Quiz" });
  assert.deepEqual(inPersonDecision({ title: "Ústne skúšanie", desc: "", taskKind: "Worksheet" }),
    { actionType: "in_person", taskKind: "Presentation" },
    "an oral is a Presentation, and the capital Ú must not hide it");
});

test("case comes from the title as written, not from the caller", () => {
  assert.deepEqual(inPersonDecision({ title: "PÍSOMKA", desc: "", taskKind: "Worksheet" }),
    { actionType: "in_person", taskKind: "Test" });
});

test("work handed in online is not in-person at all", () => {
  assert.deepEqual(inPersonDecision({ title: "Essay", desc: "Upload your essay to the Google Doc.", taskKind: "Essay" }), {});
  // A submit verb does not rescue an assessment named in the title.
  assert.equal(inPersonDecision({ title: "Test - Newton", desc: "Submit your answers.", taskKind: "Worksheet" }).actionType, "in_person");
});

test("a kind that already describes an assessment is left alone", () => {
  assert.deepEqual(inPersonDecision({ title: "Test - Newton", desc: "", taskKind: "Test" }), { actionType: "in_person" });
  assert.deepEqual(inPersonDecision({ title: "Prezentácia", desc: "", taskKind: "Presentation" }), { actionType: "in_person" });
});

test("nothing at all is not a decision", () => {
  assert.deepEqual(inPersonDecision(), {});
  assert.deepEqual(inPersonDecision({ title: "Read chapter 4", desc: "", taskKind: "Reading" }), {});
});
