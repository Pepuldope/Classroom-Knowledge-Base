import test from "node:test";
import assert from "node:assert/strict";
import { isEnrichCandidate, isSubmittedState, SUBMITTED_STATES } from "../enrich-scope.js";

test("recognises the states that mean the work is handed in", () => {
  for (const s of SUBMITTED_STATES) assert.equal(isSubmittedState(s), true, s);
  for (const s of [undefined, null, "NEW", "CREATED", "RECLAIMED_BY_STUDENT"]) {
    assert.equal(isSubmittedState(s), false, String(s));
  }
});

test("submitted work is still worth analyzing", () => {
  // The regression this file exists for: the lazy pass required isPending(),
  // and isInScope() honours a display preference that defaults to hiding
  // completed work, so a submitted assignment was excluded from both paths and
  // never got a type at all.
  for (const state of SUBMITTED_STATES) {
    assert.equal(
      isEnrichCandidate({ kind: "assignment", submissionState: state }),
      true,
      `${state} should still be enriched`
    );
  }
});

test("pending work is a candidate", () => {
  assert.equal(isEnrichCandidate({ kind: "assignment", submissionState: undefined }), true);
  assert.equal(isEnrichCandidate({ kind: "assignment", submissionState: "NEW" }), true);
});

test("only assignments are candidates", () => {
  for (const kind of ["material", "announcement", undefined]) {
    assert.equal(isEnrichCandidate({ kind, submissionState: "NEW" }), false, String(kind));
  }
});

test("does not re-request work that already has an enrichment", () => {
  assert.equal(isEnrichCandidate({ kind: "assignment", hasEnrichment: true }), false);
});

test("skips stale and dismissed work", () => {
  // Each call spends a request against a shared free quota; long-abandoned and
  // explicitly dismissed work is not worth one.
  assert.equal(isEnrichCandidate({ kind: "assignment", stale: true }), false);
  assert.equal(isEnrichCandidate({ kind: "assignment", dismissed: true }), false);
});

test("a stale but submitted assignment is still skipped", () => {
  // Stale wins: it was handed in long ago and nothing on screen needs it.
  assert.equal(
    isEnrichCandidate({ kind: "assignment", submissionState: "TURNED_IN", stale: true }),
    false
  );
});

test("tolerates being called with nothing", () => {
  assert.equal(isEnrichCandidate(), false);
  assert.equal(isEnrichCandidate({}), false);
});
