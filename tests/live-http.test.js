// Tests for the live-check edge-mitigation classifier.
//
// The whole point of isEdgeMitigation() is to tell "the edge refused the test
// runner" apart from "the app returned an error". Getting this wrong in either
// direction is costly:
//   - false positive → a REAL 403 regression gets downgraded to a warning and
//     ships silently. These tests exist mostly to prevent this.
//   - false negative → the autonomous loop raises a phantom blocker again.

import test from "node:test";
import assert from "node:assert/strict";
import { isEdgeMitigation, EXIT_INCONCLUSIVE } from "../scripts/live-http.mjs";

test("EX_TEMPFAIL is distinct from a normal failure", () => {
  assert.equal(EXIT_INCONCLUSIVE, 75);
  assert.notEqual(EXIT_INCONCLUSIVE, 0);
  assert.notEqual(EXIT_INCONCLUSIVE, 1);
});

test("detects an explicit Vercel mitigation header", () => {
  assert.equal(isEdgeMitigation(403, { "x-vercel-mitigated": "challenge" }, ""), true);
  // Header casing from different clients must not matter.
  assert.equal(isEdgeMitigation(403, { "X-Vercel-Mitigated": "challenge" }, ""), true);
});

test("detects a challenge token/nonce header", () => {
  assert.equal(isEdgeMitigation(403, { "x-vercel-challenge-token": "abc" }, ""), true);
  assert.equal(isEdgeMitigation(429, { "x-vercel-challenge-nonce": "xyz" }, ""), true);
});

test("detects the challenge interstitial body", () => {
  const body = "<html><title>Vercel Security Checkpoint</title></html>";
  assert.equal(isEdgeMitigation(403, { "content-type": "text/html" }, body), true);
});

test("detects an HTML page served from a JSON API route", () => {
  assert.equal(isEdgeMitigation(403, { "content-type": "text/html; charset=utf-8" }, "<html>nope</html>"), true);
});

// ---- the important direction: real app errors must stay real ----

test("does NOT flag the app's own JSON 403", () => {
  const headers = { "content-type": "application/json" };
  assert.equal(isEdgeMitigation(403, headers, '{"error":"forbidden"}'), false);
});

test("does NOT flag a JSON 403 even when content-type is missing", () => {
  assert.equal(isEdgeMitigation(403, {}, '{"error":"not your note"}'), false);
});

test("does NOT flag non-403/429 statuses", () => {
  // A genuine outage or bad deploy must never be excused as mitigation.
  for (const status of [200, 400, 401, 404, 405, 500, 502, 503]) {
    assert.equal(
      isEdgeMitigation(status, { "x-vercel-mitigated": "challenge" }, ""),
      false,
      `status ${status} must not be treated as mitigation`
    );
  }
});

test("does NOT flag a plain 403 with no evidence", () => {
  assert.equal(isEdgeMitigation(403, { "server": "Vercel" }, ""), false);
});

test("tolerates absent headers and body", () => {
  assert.equal(isEdgeMitigation(403, null), false);
  assert.equal(isEdgeMitigation(403, undefined, undefined), false);
});
