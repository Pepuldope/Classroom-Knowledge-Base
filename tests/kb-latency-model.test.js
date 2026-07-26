import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSamples } from "../scripts/kb_latency_test.mjs";

test("summarizeSamples separates the cold request from warm repeats", () => {
  assert.deepEqual(summarizeSamples([1200, 800, 900]), {
    coldMs: 1200,
    warmMs: [800, 900],
    warmMaxMs: 900,
    warmAverageMs: 850,
  });
});

test("summarizeSamples rejects an incomplete probe", () => {
  assert.throws(() => summarizeSamples([800]), /at least two samples/);
});
