import test from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../kb-client-search.js";

test("searchNotes falls back to title and topic when a note has no body or summary", () => {
  const results = searchNotes([
    { t: "Quadratic equations", course: "Algebra", topic: "Polynomials" },
  ], "quadratic");

  assert.equal(results.length, 1);
  assert.equal(results[0]._snippet, "Quadratic equations — Polynomials");
});
