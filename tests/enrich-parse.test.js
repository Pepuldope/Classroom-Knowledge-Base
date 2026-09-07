import test from "node:test";
import assert from "node:assert/strict";
import { parseModelJson } from "../api/enrich.js";

const OBJ = '{"weight":3,"actionType":"submit_online","taskKind":"Worksheet","estimatedMinutes":30,"oneLineSummary":"Odovzdaj kópiu"}';

test("parses a plain JSON completion", () => {
  assert.equal(parseModelJson(OBJ).taskKind, "Worksheet");
});

test("parses JSON wrapped in a code fence", () => {
  assert.equal(parseModelJson("```json\n" + OBJ + "\n```").estimatedMinutes, 30);
});

test("parses JSON that follows a reasoning preamble", () => {
  // The live failure: the model narrated before answering.
  const raw = `Here's a thinking process: 1. **Analyze the Input:** - Course: ML Y4 Omega\nSo the answer is:\n${OBJ}`;
  assert.equal(parseModelJson(raw).actionType, "submit_online");
});

test("ignores a brace inside the preamble instead of spanning from it", () => {
  // The old greedy /\{[\s\S]*\}/ matched from this brace to the final one and
  // produced garbage.
  const raw = `Thinking: the shape is {weight, taskKind}. Answer:\n${OBJ}`;
  const v = parseModelJson(raw);
  assert.equal(v.weight, 3);
});

test("takes the answer after the reasoning, not a draft before it", () => {
  const draft = '{"weight":1,"taskKind":"Reading","estimatedMinutes":5}';
  assert.equal(parseModelJson(`First guess ${draft} but actually:\n${OBJ}`).taskKind, "Worksheet");
});

test("tolerates braces inside strings", () => {
  const tricky = '{"oneLineSummary":"use the {template} file","taskKind":"Essay","estimatedMinutes":45}';
  assert.equal(parseModelJson(tricky).taskKind, "Essay");
});

test("returns null when there is no object at all", () => {
  assert.equal(parseModelJson("I cannot help with that."), null);
  assert.equal(parseModelJson(""), null);
  assert.equal(parseModelJson(undefined), null);
});

test("returns null for a truncated object", () => {
  // What actually happened: the budget ran out mid-thought.
  assert.equal(parseModelJson('Here is my thinking... {"weight":3,"taskKi'), null);
});
