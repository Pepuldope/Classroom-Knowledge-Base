// The assignment panel's facts, before anything draws them.
import test from "node:test";
import assert from "node:assert/strict";
import { assignmentPanelModel, estimateLabel, groundingLineModel, postedModel } from "../assignment-panel.js";

test("estimates read as a person would say them", () => {
  assert.equal(estimateLabel(45), "45m");
  assert.equal(estimateLabel(60), "1h");
  assert.equal(estimateLabel(180), "3h");
  assert.equal(estimateLabel(95), "1h 35m");
  assert.equal(estimateLabel(0), "", "no estimate is not '0m'");
  assert.equal(estimateLabel(null), "");
  assert.equal(estimateLabel("nonsense"), "");
});

test("the fact row is short, labelled, and in reading order", () => {
  const model = assignmentPanelModel({
    courseName: "Náuka o podnikaní Y3 3.T",
    dueLabel: "Wed, Sep 10",
    enrichment: { estimatedMinutes: 180, taskKind: "Presentation" },
  });
  assert.deepEqual(model.facts.map((f) => f.key), ["course", "due", "estimate", "kind"]);
  assert.deepEqual(model.facts.map((f) => f.value), ["Náuka o podnikaní Y3 3.T", "Wed, Sep 10", "3h", "Presentation"]);
});

test("absent facts leave no empty chip behind", () => {
  const model = assignmentPanelModel({ courseName: "Algebra" });
  assert.deepEqual(model.facts.map((f) => f.key), ["course"]);
  assert.equal(model.summary, "");
  assert.equal(model.note, "");
  assert.equal(model.hasDescription, false);
  assert.equal(model.materialCount, 0);
});

test("submitted work says so in the fact row", () => {
  const model = assignmentPanelModel({ courseName: "Algebra", submitted: true });
  assert.equal(model.facts.at(-1).value, "Submitted");
});

test("only the action type that changes what you do gets a sentence", () => {
  assert.equal(assignmentPanelModel({ enrichment: { actionType: "in_person" } }).note,
    "In-person task — nothing to upload");
  // submit_online is the default and telling someone the default is noise.
  assert.equal(assignmentPanelModel({ enrichment: { actionType: "submit_online" } }).note, "");
  assert.equal(assignmentPanelModel({ enrichment: { actionType: "read_only" } }).note, "");
  assert.equal(assignmentPanelModel({}).note, "");
});

test("the model carries no HTML — escaping stays with the renderer", () => {
  const model = assignmentPanelModel({
    courseName: '<img src=x onerror=alert(1)>',
    enrichment: { oneLineSummary: "<b>bold</b>" },
  });
  assert.equal(model.facts[0].value, '<img src=x onerror=alert(1)>', "passed through verbatim");
  assert.equal(model.summary, "<b>bold</b>");
  assert.ok(!JSON.stringify(model).includes("&lt;"), "nothing is pre-escaped here");
});

test("degenerate input produces an empty but usable model", () => {
  const model = assignmentPanelModel();
  assert.deepEqual(model.facts, []);
  assert.deepEqual(model.materials, []);
  assert.equal(model.link, "");
  assert.equal(assignmentPanelModel({ materials: "not an array" }).materialCount, 0);
  assert.equal(assignmentPanelModel({ materials: [null, undefined] }).materialCount, 0);
});

test("the grounding line replaces a box that repeated the whole panel", () => {
  assert.equal(groundingLineModel({ materialCount: 0 }), "Reading this assignment");
  assert.equal(groundingLineModel({ materialCount: 1 }), "Reading this assignment and its 1 attachment");
  assert.equal(groundingLineModel({ materialCount: 4 }), "Reading this assignment and its 4 attachments");
  assert.equal(groundingLineModel(), "Reading this assignment");
});


// --- When it was posted ---------------------------------------------------
// Requested 2026-09-10: the panel said what and when-due, never when it went
// up — the fact you want when deciding whether you have already seen this.

test("the panel carries the date the assignment was posted", () => {
  const m = assignmentPanelModel({ creationTime: "2026-09-08T07:30:00Z" });
  assert.equal(m.posted.postedAt.toISOString(), "2026-09-08T07:30:00.000Z");
  assert.equal(m.posted.showUpdated, false);
});

test("an edit a day or more later is worth saying; Classroom's own save is not", () => {
  const sameDay = postedModel({
    creationTime: "2026-09-08T07:30:00Z", updateTime: "2026-09-08T07:31:00Z",
  });
  assert.equal(sameDay.showUpdated, false, "a minute later is Classroom, not the teacher");
  assert.equal(sameDay.updatedAt, null);

  const laterEdit = postedModel({
    creationTime: "2026-09-08T07:30:00Z", updateTime: "2026-09-09T18:00:00Z",
  });
  assert.equal(laterEdit.showUpdated, true);
  assert.equal(laterEdit.updatedAt.toISOString(), "2026-09-09T18:00:00.000Z");
});

test("no creation time means the panel says nothing about posting", () => {
  const m = postedModel({ creationTime: "", updateTime: "2026-09-09T18:00:00Z" });
  assert.deepEqual(m, { postedAt: null, updatedAt: null, showUpdated: false });
});
