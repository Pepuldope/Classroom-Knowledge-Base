import test from "node:test";
import assert from "node:assert/strict";
import { addStudyAnswer, removeStudyAnswer, studyListModel } from "../kb.js";

test("studyListModel keeps only valid locally saved tutor answers", () => {
  const list = studyListModel([
    { id: "a", text: "  Review quadratic formula  ", savedAt: 1 },
    { id: "", text: "ignored", savedAt: 2 },
    { id: "b", text: "", savedAt: 3 },
  ]);
  assert.deepEqual(list, [{ id: "a", text: "Review quadratic formula", savedAt: 1 }]);
});

test("addStudyAnswer deduplicates the same tutor answer", () => {
  const first = addStudyAnswer([], "Use the chain rule", 10);
  const second = addStudyAnswer(first, "  Use the chain rule ", 20);
  assert.deepEqual(second, [{ id: "use-the-chain-rule", text: "Use the chain rule", savedAt: 10 }]);
});

test("removeStudyAnswer removes only the selected saved answer", () => {
  const list = [
    { id: "a", text: "A", savedAt: 1 },
    { id: "b", text: "B", savedAt: 2 },
  ];
  assert.deepEqual(removeStudyAnswer(list, "a"), [{ id: "b", text: "B", savedAt: 2 }]);
});
