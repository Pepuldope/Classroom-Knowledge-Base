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
import { inPersonDecision, takeHomeDecision } from "../api/enrich.js";

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

test("an essay that is sent in is not in-person, even if the text mentions class", () => {
  // Peter, 2026-10-02: a voluntary English essay "to be sent in" came back as
  // an in-person task. Sending/emailing is how it is handed in.
  for (const desc of [
    "Send it to me by Friday. We will talk about it in class.",
    "Email your essay to me, we will read the best ones in class.",
    "Pošlite mi esej mailom, rozoberieme to na hodine.",
    "Zašlite to do piatku, prečítame si ich v triede.",
  ]) assert.deepEqual(inPersonDecision({ title: "Voluntary essay", desc, taskKind: "Essay" }), {}, desc);
});

test("take-home written work the model called in-person is handed in", () => {
  assert.deepEqual(takeHomeDecision({ title: "voluntary essay", desc: "", actionType: "in_person", taskKind: "Essay" }),
    { actionType: "submit_online" });
  assert.deepEqual(takeHomeDecision({ title: "project: my town", desc: "", actionType: "in_person", taskKind: "Project" }),
    { actionType: "submit_online" });
  // An essay written in class as an assessment really is in person.
  assert.deepEqual(takeHomeDecision({ title: "písomka - sloh", desc: "", actionType: "in_person", taskKind: "Essay" }), {});
  assert.deepEqual(takeHomeDecision({ title: "essay", desc: "We will write it in class.", actionType: "in_person", taskKind: "Essay" }), {});
  // Tests and worksheets are not touched.
  assert.deepEqual(takeHomeDecision({ title: "Test", desc: "", actionType: "in_person", taskKind: "Test" }), {});
  assert.deepEqual(takeHomeDecision({ title: "essay", desc: "", actionType: "submit_online", taskKind: "Essay" }), {});
});
