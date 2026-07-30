import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSamples, compareLatency } from "../scripts/kb_latency_test.mjs";
import { bundleCacheState } from "../api/kb-store.js";
import { searchResponseCacheState } from "../api/kb-response-cache.js";

test("bundleCacheState reuses a fresh populated bundle", () => {
  const bundle = { version: 1, notes: [{ t: "Algebra" }] };
  assert.equal(bundleCacheState({ bundle, cachedAt: 1000 }, 1500, 5000), bundle);
});

test("bundleCacheState rejects missing, empty, and expired cache entries", () => {
  assert.equal(bundleCacheState(null, 1500, 5000), null);
  assert.equal(bundleCacheState({ bundle: { notes: [] }, cachedAt: 1000 }, 1500, 5000), null);
  assert.equal(bundleCacheState({ bundle: { notes: [{ t: "Algebra" }] }, cachedAt: 1000 }, 7000, 5000), null);
});

test("searchResponseCacheState reuses a fresh response for the same bundle and key", () => {
  const bundle = { version: 1, notes: [{ t: "Algebra" }] };
  const response = { results: [{ t: "Algebra" }] };
  assert.equal(searchResponseCacheState({ key: "algebra", bundle, response, cachedAt: 1000 }, "algebra", bundle, 1500, 5000), response);
});

test("searchResponseCacheState rejects stale, mismatched, and empty cache entries", () => {
  const bundle = { version: 1, notes: [{ t: "Algebra" }] };
  const otherBundle = { version: 1, notes: [{ t: "Biology" }] };
  assert.equal(searchResponseCacheState(null, "algebra", bundle, 1500, 5000), null);
  assert.equal(searchResponseCacheState({ key: "algebra", bundle, response: {}, cachedAt: 1000 }, "biology", bundle, 1500, 5000), null);
  assert.equal(searchResponseCacheState({ key: "algebra", bundle, response: {}, cachedAt: 1000 }, "algebra", otherBundle, 1500, 5000), null);
  assert.equal(searchResponseCacheState({ key: "algebra", bundle, response: {}, cachedAt: 1000 }, "algebra", bundle, 7000, 5000), null);
});

test("summarizeSamples separates the cold request from warm repeats", () => {
  assert.deepEqual(summarizeSamples([1200, 800, 900, 1000]), {
    coldMs: 1200,
    warmMs: [800, 900, 1000],
    warmMaxMs: 1000,
    warmAverageMs: 900,
    warmP95Ms: 1000,
  });
});

test("summarizeSamples reports p95 across three warm repeats", () => {
  assert.deepEqual(summarizeSamples([1200, 800, 900, 1000]), {
    coldMs: 1200,
    warmMs: [800, 900, 1000],
    warmMaxMs: 1000,
    warmAverageMs: 900,
    warmP95Ms: 1000,
  });
});

test("summarizeSamples rejects a probe without three warm repeats", () => {
  assert.throws(() => summarizeSamples([800, 700, 750]), /at least four samples/);
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
