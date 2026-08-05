import test from "node:test";
import assert from "node:assert/strict";
import { summarizeWarmTransitionSamples } from "../kb-transition-timing.js";

test("summarizeWarmTransitionSamples reports bounded warm transition metrics", () => {
  assert.deepEqual(summarizeWarmTransitionSamples([12, 8, 10]), {
    samples: 3,
    averageMs: 10,
    maxMs: 12,
    p95Ms: 12,
    budgetMs: 100,
    withinBudget: true,
  });
});

test("summarizeWarmTransitionSamples rejects incomplete or invalid samples", () => {
  assert.throws(() => summarizeWarmTransitionSamples([12, 8]), /three warm samples/);
  assert.throws(() => summarizeWarmTransitionSamples([12, NaN, 10]), /finite/);
});
