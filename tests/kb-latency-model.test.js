// kb-latency-model.test.js — the shared-store bundle cache.
//
// The search-response cache and the latency probe tests went with
// /api/kb-search: the browser searches its own bundle, so there is no hosted
// search round trip left to measure. kb-store.js survives because vault
// ingestion still writes through it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleCacheState } from "../api/kb-store.js";

test("bundleCacheState reuses a fresh populated bundle", () => {
  const bundle = { version: 1, notes: [{ t: "Algebra" }] };
  assert.equal(bundleCacheState({ bundle, cachedAt: 1000 }, 1500, 5000), bundle);
});


test("bundleCacheState rejects missing, empty, and expired cache entries", () => {
  assert.equal(bundleCacheState(null, 1500, 5000), null);
  assert.equal(bundleCacheState({ bundle: { notes: [] }, cachedAt: 1000 }, 1500, 5000), null);
  assert.equal(bundleCacheState({ bundle: { notes: [{ t: "Algebra" }] }, cachedAt: 1000 }, 7000, 5000), null);
});








