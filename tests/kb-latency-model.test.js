import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSamples, compareLatency } from "../scripts/kb_latency_test.mjs";

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

test("compareLatency reports bounded local and hosted warm metrics", () => {
  assert.deepEqual(compareLatency({ warmAverageMs: 12.3456 }, { warmAverageMs: 987.6543 }), {
    localWarmAverageMs: 12.35,
    hostedWarmAverageMs: 987.65,
    hostedMinusLocalMs: 975.31,
    hostedToLocalRatio: 80,
  });
});

test("compareLatency rejects missing or invalid warm summaries", () => {
  assert.throws(() => compareLatency(null, { warmAverageMs: 10 }), /warm summaries/);
  assert.throws(() => compareLatency({ warmAverageMs: 0 }, { warmAverageMs: 10 }), /positive/);
});
