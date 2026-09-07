import test from "node:test";
import assert from "node:assert/strict";
import { TASK_KINDS, normalizeTaskKind, isTaskKind } from "../task-kinds.js";

test("the vocabulary is exactly the agreed twelve", () => {
  assert.deepEqual(TASK_KINDS, [
    "Test", "Quiz", "Essay", "Project", "Reading", "Worksheet",
    "Practice", "Presentation", "Lab", "Video", "Notes", "Translation",
  ]);
});

test("canonical kinds pass through, whatever the case", () => {
  for (const k of TASK_KINDS) {
    assert.equal(normalizeTaskKind(k), k);
    assert.equal(normalizeTaskKind(k.toLowerCase()), k);
    assert.equal(normalizeTaskKind(k.toUpperCase()), k);
  }
});

test("every result is always one of the twelve", () => {
  const junk = ["Question", "Problem set", "Assignment", "", null, undefined, "🙂", "Blah blah", 42];
  for (const v of junk) assert.ok(isTaskKind(normalizeTaskKind(v)), `${v} -> ${normalizeTaskKind(v)}`);
});

test("the labels that prompted the rewrite are gone", () => {
  // "Question" shipped from the prompt; "Problem set" replaced it and read
  // just as badly.
  assert.equal(normalizeTaskKind("Question"), "Practice");
  assert.equal(normalizeTaskKind("Problem set"), "Practice");
  assert.equal(normalizeTaskKind("problem-set"), "Practice");
  for (const generic of ["Assignment", "Task", "Homework", "Work"]) {
    assert.equal(normalizeTaskKind(generic), "Worksheet");
  }
});

test("retired kinds map onto survivors, so cached entries stay valid", () => {
  // Enrichments stored before the list shrank must still render.
  assert.equal(normalizeTaskKind("Exam"), "Test");
  assert.equal(normalizeTaskKind("Report"), "Essay");
  assert.equal(normalizeTaskKind("Analysis"), "Essay");
  assert.equal(normalizeTaskKind("Research"), "Project");
  assert.equal(normalizeTaskKind("Interview"), "Presentation");
  assert.equal(normalizeTaskKind("Recording"), "Presentation");
  assert.equal(normalizeTaskKind("Discussion"), "Presentation");
  assert.equal(normalizeTaskKind("Vocabulary"), "Practice");
  assert.equal(normalizeTaskKind("Listening"), "Practice");
  assert.equal(normalizeTaskKind("Drawing"), "Worksheet");
  assert.equal(normalizeTaskKind("Review"), "Reading");
});

test("Slovak labels resolve", () => {
  assert.equal(normalizeTaskKind("písomka"), "Test");
  assert.equal(normalizeTaskKind("kvíz"), "Quiz");
  assert.equal(normalizeTaskKind("preklad"), "Translation");
  assert.equal(normalizeTaskKind("slovíčka"), "Practice");
});

test("falls back to the assignment text when the label is unusable", () => {
  assert.equal(normalizeTaskKind("???", "vstupný test z matematiky"), "Test");
  assert.equal(normalizeTaskKind("", "prečítaj si článok o SNP"), "Reading");
  assert.equal(normalizeTaskKind(null, "preklad viet do angličtiny"), "Translation");
  assert.equal(normalizeTaskKind(undefined, "laboratórna práca — pokus"), "Lab");
  assert.equal(normalizeTaskKind("", "napíš slohovú prácu"), "Essay");
});

test("falls back to Worksheet when there is nothing to go on", () => {
  assert.equal(normalizeTaskKind("", ""), "Worksheet");
});
