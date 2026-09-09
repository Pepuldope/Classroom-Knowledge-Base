// What a reload is allowed to remember, and where it puts you back.
import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionPositionModel,
  positionNeedsRestore,
  canRestoreScroll,
  MAX_POSITION_QUERY,
} from "../session-position.js";

test("a cold load lands on the Planner, on Search, at the top", () => {
  assert.deepEqual(sessionPositionModel(), { view: "planner", tab: "search", query: "", scroll: 0 });
  assert.deepEqual(sessionPositionModel(null), { view: "planner", tab: "search", query: "", scroll: 0 });
  assert.deepEqual(sessionPositionModel("kb"), { view: "planner", tab: "search", query: "", scroll: 0 });
  assert.deepEqual(sessionPositionModel([]), { view: "planner", tab: "search", query: "", scroll: 0 });
});

test("a real position round-trips", () => {
  assert.deepEqual(
    sessionPositionModel({ view: "kb", tab: "browse", query: "quadratic", scroll: 1840 }),
    { view: "kb", tab: "browse", query: "quadratic", scroll: 1840 },
  );
});

test("an unknown route or tab falls back rather than blanking the page", () => {
  // A stored value from a future (or hand-edited) build must not leave setView
  // and setStudyTab hiding every panel there is.
  const p = sessionPositionModel({ view: "archive", tab: "flashcards", scroll: 100 });
  assert.equal(p.view, "planner");
  assert.equal(p.tab, "search");
  assert.equal(p.scroll, 100, "the offset is still usable even when the route is not");
});

test("scroll offsets are sanitized", () => {
  assert.equal(sessionPositionModel({ scroll: -40 }).scroll, 0, "a negative offset is the top");
  assert.equal(sessionPositionModel({ scroll: 12.6 }).scroll, 13, "sub-pixel offsets are pointless");
  assert.equal(sessionPositionModel({ scroll: "900" }).scroll, 900);
  assert.equal(sessionPositionModel({ scroll: NaN }).scroll, 0);
  assert.equal(sessionPositionModel({ scroll: Infinity }).scroll, 0);
});

test("the query is capped, so a pasted essay never reaches storage", () => {
  const long = "a".repeat(MAX_POSITION_QUERY + 500);
  assert.equal(sessionPositionModel({ query: long }).query.length, MAX_POSITION_QUERY);
  assert.equal(sessionPositionModel({ query: 42 }).query, "");
  // Not trimmed: a trailing space is a query still being typed, and dropping it
  // would change the results the reader comes back to.
  assert.equal(sessionPositionModel({ query: "log " }).query, "log ");
});

test("restoring is skipped when there is nothing to restore", () => {
  assert.equal(positionNeedsRestore(null), false);
  assert.equal(positionNeedsRestore({ view: "planner", tab: "search" }), false);
  assert.equal(positionNeedsRestore({ view: "kb" }), true);
  assert.equal(positionNeedsRestore({ tab: "curriculum" }), true);
  assert.equal(positionNeedsRestore({ query: "logs" }), true);
  assert.equal(positionNeedsRestore({ scroll: 200 }), true);
});

test("scroll is only restored once the page is tall enough to hold it", () => {
  // The Planner list arrives after a Classroom round-trip: at DOMContentLoaded
  // the page is a header and a spinner, and scrollTo(0, 1840) is a no-op.
  assert.equal(canRestoreScroll(1840, { scrollHeight: 900, viewportHeight: 844 }), false);
  assert.equal(canRestoreScroll(1840, { scrollHeight: 4000, viewportHeight: 844 }), true);
  // Exactly reachable counts.
  assert.equal(canRestoreScroll(1000, { scrollHeight: 1844, viewportHeight: 844 }), true);
  assert.equal(canRestoreScroll(0, { scrollHeight: 4000, viewportHeight: 844 }), false);
  assert.equal(canRestoreScroll(NaN, { scrollHeight: 4000, viewportHeight: 844 }), false);
});
