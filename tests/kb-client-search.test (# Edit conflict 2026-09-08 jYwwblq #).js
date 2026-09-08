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

test("the token index is cached per notes array, not rebuilt per query", async () => {
  const { searchNotes, suggestCorrection } = await import("../kb-client-search.js");
  // Big enough that a rebuild is measurable against a cache hit.
  const notes = [];
  for (let i = 0; i < 1200; i++) {
    notes.push({ p: `y/c/${i}`, t: `Assignment ${i}`, course: `Course ${i % 20}`, y: "2025-26",
      topic: `Sprint ${i % 6}`, s: "summary text", x: "market research strategy customer ".repeat(90) });
  }
  const first = process.hrtime.bigint();
  searchNotes(notes, "market");
  const cold = Number(process.hrtime.bigint() - first) / 1e6;

  const second = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) searchNotes(notes, `research ${i}`);
  const warm = Number(process.hrtime.bigint() - second) / 1e6 / 5;

  assert.ok(warm < cold, `warm search (${warm.toFixed(1)}ms) should beat the cold build (${cold.toFixed(1)}ms)`);

  // A different array is a different corpus and must not reuse the index.
  const other = [{ p: "z/1", t: "Totally unrelated", course: "Z", y: "2025-26", x: "zzz" }];
  assert.equal(searchNotes(other, "market").length, 0, "a different notes array must be indexed on its own");
  assert.ok(searchNotes(notes, "market").length > 0, "and the original index still works");
});

test("suggestCorrection trusts a caller that already ran the search", async () => {
  const { suggestCorrection } = await import("../kb-client-search.js");
  const notes = [{ p: "a/1", t: "Algebra", course: "Math", y: "2025-26", s: "quadratic", x: "quadratic equations" }];
  // Told there are results, it must not offer a correction (nor re-search).
  assert.equal(suggestCorrection(notes, "algebra", { hasResults: true }), null);
  // Told there are none, it behaves as before. ("algebre" is no use as a test
  // case: it already fuzzy-matches "algebra", so no correction is warranted.)
  assert.equal(suggestCorrection(notes, "algbra", { hasResults: false }), "algebra");
  // Not told, it works it out itself — the old signature still holds.
  assert.equal(suggestCorrection(notes, "algbra"), "algebra");
  assert.equal(suggestCorrection(notes, "algebra"), null);
  // hasResults:true is a promise the caller keeps; it must not be second-guessed.
  assert.equal(suggestCorrection(notes, "algbra", { hasResults: true }), null);
});
