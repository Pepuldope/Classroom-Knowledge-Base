// kb_e2e_test.mjs — end-to-end sanity gate for the Knowledge Base.
//
// Runs WITHOUT Vercel / KV: kb-store.js falls back to a process-memory Map
// when KV_REST_API_URL / KV_REST_API_TOKEN are absent, so this test seeds its
// own bundle in-memory and exercises the real retrieval + search route code
// that production uses.
//
// Covers (the guardrail Step-3 gate requires `node scripts/kb_e2e_test.mjs`
// to exit 0):
//   1. searchNotes ranking (title > summary > body)
//   2. fuzzy token matching (stem match on query side)
//   3. snippet positioning around the matched term
//   4. /api/kb-search route: q-required 400, results + facet chips
//   5. /api/kb-search route: course/year filter narrowing
//   6. empty / unset DB returns empty results (empty:true)
//
// Uses node:test + node:assert (node 22 ships both). Exit code is non-zero on
// any failure, 0 when all pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { searchNotes, relatedNotes, suggestCorrection, relatedNotesPreview, makeSortFn } from "../api/kb-retrieval.js";
import kbSearch from "../api/kb-search.js";
import kbNote from "../api/kb-note.js";
import kbRelated from "../api/kb-related.js";
import kbBrowse from "../api/kb-browse.js";
import { saveBundle, getBundle } from "../api/kb-store.js";
import { bundleFromVault } from "../archive-builder.js";
import { highlightSnippet, tutorSourceList, kbFilterModel, kbSettingsModel, kbSearchStateModel, groupCourseNotesBySprint, buildLocalSearchResponse, localNoteFromBundle, localRelatedFromBundle, INTERACTIVE_OAUTH_PROMPT } from "../kb.js";
import { renderRichMarkdown, renderAssignmentDescription } from "../archive.js";
import { validateKbBundle } from "../kb-local.js";

// Minimal Edge-like Request for the route handler (node 22 has global Request).
function makeReq(url, method = "GET") {
  return new Request("http://localhost" + url, { method });
}

test("private KB UI copy does not promise a shared database", async () => {
  const source = await readFile(new URL("../kb.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /into the shared DB|Uploading archive\.json to the shared DB/);
  assert.match(source, /into your knowledge base|your knowledge base/);
});

test("kbSettingsModel normalizes KB controls and preserves local-only defaults", () => {
  assert.deepEqual(kbSettingsModel(), {
    tutorEnabled: true,
    tutorEffort: "tutor",
    defaultScope: "all",
    defaultSort: "recency",
    relatedCount: 3,
    density: "comfortable",
    autoBuild: false,
  });
  assert.deepEqual(kbSettingsModel({ tutorEffort: "invalid", relatedCount: 99, density: "compact", autoBuild: true }), {
    tutorEnabled: true,
    tutorEffort: "tutor",
    defaultScope: "all",
    defaultSort: "recency",
    relatedCount: 8,
    density: "compact",
    autoBuild: true,
  });
});

test("kbSearchStateModel keeps only valid local filter and sort choices", () => {
  assert.deepEqual(kbSearchStateModel({
    course: "Math",
    year: "2024-25",
    kind: "assignment",
    family: "engineering",
    sort: "title",
  }), {
    course: "Math",
    year: "2024-25",
    kind: "assignment",
    family: "engineering",
    sort: "title",
  });
  assert.deepEqual(kbSearchStateModel({ course: 42, sort: "unsupported" }), {
    course: "",
    year: "",
    kind: "",
    family: "",
    sort: "relevance",
  });
});

test("buildLocalSearchResponse searches a cached private bundle and applies facets locally", () => {
  const bundle = sampleBundle();
  const response = buildLocalSearchResponse(bundle, "cover letter", {
    course: "BEng Y1",
    year: "2023-24",
    limit: 8,
  });
  assert.equal(response.filteredCount, 1);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].course, "BEng Y1");
  assert.ok(response.filters.courses.includes("ELA 1 Gama"));
  assert.ok(response.results[0]._snippet, "local results retain snippets");
});

test("local search boosts course and topic matches for a multi-term study query", () => {
  const bundle = {
    version: 1,
    notes: [
      { t: "Weekly exercises", s: "Practice problems", x: "Complete the worksheet.", course: "History", topic: "Modern Europe", y: "2024-25" },
      { t: "Weekly exercises", s: "Practice problems", x: "Complete the worksheet.", course: "Algebra", topic: "Quadratics", y: "2024-25" },
    ],
  };
  const response = buildLocalSearchResponse(bundle, "Algebra quadratic", { limit: 2 });
  assert.equal(response.results.length, 1, "course/topic terms should retrieve the matching note");
  assert.equal(response.results[0].course, "Algebra");
});

test("local search sort orders the full filtered result set", () => {
  const bundle = {
    version: 1,
    notes: [
      { t: "Zulu lesson", s: "Algebra", x: "", course: "Math", y: "2024-25" },
      { t: "Alpha lesson", s: "Algebra", x: "", course: "Math", y: "2024-25" },
      { t: "Middle lesson", s: "Algebra", x: "", course: "Math", y: "2024-25" },
    ],
  };
  const response = buildLocalSearchResponse(bundle, "Algebra", { sort: "title", limit: 2 });
  assert.deepEqual(response.results.map((note) => note.t), ["Alpha lesson", "Middle lesson"]);
});
test("recency sort sinks undated notes after dated notes", () => {
  const notes = [
    { t: "Undated", s: "Algebra", y: "undated" },
    { t: "Dated", s: "Algebra", y: "2024-25" },
  ];
  const results = searchNotes(notes, "Algebra", { limit: 2, sortFn: makeSortFn("recency") });
  assert.deepEqual(results.map((note) => note.t), ["Dated", "Undated"]);
});

test("local search preserves original bundle indices when facets filter notes", () => {
  const bundle = {
    version: 1,
    notes: [
      { t: "Other course", s: "Algebra", course: "History", y: "2024-25" },
      { t: "Target note", s: "Algebra", course: "Math", y: "2024-25" },
    ],
  };
  const response = buildLocalSearchResponse(bundle, "Algebra", { course: "Math" });
  assert.equal(response.results[0].noteIndex, 1);
  assert.equal(localNoteFromBundle(bundle, response.results[0].noteIndex).t, "Target note");
});

test("local search returns typo corrections when the query has no direct match", () => {
  const bundle = { version: 1, notes: [{ t: "Mitochondria", s: "Cell biology", x: "Energy" }] };
  const response = buildLocalSearchResponse(bundle, "mitocondria");
  assert.equal(response.results.length, 0);
  assert.equal(response.didYouMean, "mitochondria");
});

test("local note and related lookups use only the cached bundle", () => {
  const bundle = {
    version: 1,
    notes: [
      { t: "Algebra one", course: "Math", topic: "Algebra", x: "linear equations" },
      { t: "Algebra two", course: "Math", topic: "Algebra", x: "quadratics" },
    ],
  };
  assert.equal(localNoteFromBundle(bundle, 1).t, "Algebra two");
  assert.equal(localNoteFromBundle(bundle, 9), null);
  assert.equal(localRelatedFromBundle(bundle, 0, { limit: 1 })[0].noteIndex, 1);
});

test("validateKbBundle accepts a version-one notes bundle and rejects invalid input", () => {
  const valid = { version: 1, notes: [{ t: "Algebra", x: "Quadratics" }] };
  assert.equal(validateKbBundle(valid), valid);
  assert.throws(() => validateKbBundle(null), /bundle object required/);
  assert.throws(() => validateKbBundle({ version: 2, notes: [] }), /version 1/);
  assert.throws(() => validateKbBundle({ version: 1, notes: "not an array" }), /notes array/);
});

function sampleBundle() {
  return {
    version: 1,
    source: "bundle",
    generatedAt: new Date().toISOString(),
    notes: [
      {
        t: "Cover Letter Guide",
        s: "How to write a strong cover letter that lands interviews.",
        x: "A cover letter should open with a hook and show fit. Use the STAR method for achievements.",
        course: "ELA 1 Gama",
        y: "2023-24",
        topic: "Writing",
        p: "",
      },
      {
        t: "Random Biology Note",
        s: "Mitochondria are the powerhouse of the cell.",
        x: "Some students put a cover letter tip inside the body only, which is weaker than a title match.",
        course: "BEng Y1",
        y: "2023-24",
        topic: "Science",
        p: "",
      },
      {
        t: "STAR Method",
        s: "STAR stands for Situation, Task, Action, Result.",
        x: "Use STAR in interviews and your cover letter to describe accomplishments.",
        course: "BEng Y1",
        y: "2022-23",
        topic: "Interviewing",
        p: "",
      },
    ],
    years: ["2023-24", "2022-23"],
    courses: ["ELA 1 Gama", "BEng Y1"],
  };
}

// Ensure a clean in-memory DB for route tests.
async function seed(bundle) {
  await saveBundle(bundle);
}

test("searchNotes ranks title matches above body-only matches", () => {
  const notes = sampleBundle().notes;
  const results = searchNotes(notes, "cover letter", { limit: 8 });
  assert.ok(results.length >= 2, "should find at least 2 notes");
  // "Cover Letter Guide" has the query in its title (weight 5) -> must rank first.
  assert.equal(results[0].t, "Cover Letter Guide", "title match should rank first");
  // The body-only match must appear but lower.
  const bodyOnly = results.find((r) => r.t === "Random Biology Note");
  assert.ok(bodyOnly, "body-only match should be present");
  assert.ok(
    results.indexOf(results.find((r) => r.t === "Cover Letter Guide")) < results.indexOf(bodyOnly),
    "title match must outrank body-only match"
  );
});

test("searchNotes fuzzy-stem-matches the query (covering -> cover)", () => {
  const notes = sampleBundle().notes;
  const results = searchNotes(notes, "covering", { limit: 8 });
  assert.ok(results.length >= 1, "fuzzy stem should still find 'cover' notes");
  // At least one result should be a cover-letter note via fuzzy match.
  const hitTitles = results.map((r) => r.t);
  assert.ok(
    hitTitles.includes("Cover Letter Guide") || hitTitles.includes("Random Biology Note"),
    "fuzzy match should surface a cover-related note"
  );
});

test("searchNotes builds a snippet centered on the matched term", () => {
  const notes = sampleBundle().notes;
  const results = searchNotes(notes, "STAR", { limit: 8 });
  const sn = results.find((r) => r.t === "Cover Letter Guide");
  assert.ok(sn && sn._snippet, "snippet should be produced");
  // The snippet should contain the matched token somewhere (fuzzy or exact).
  assert.ok(/star/i.test(sn._snippet), "snippet should include the matched term region");
});

test("/api/kb-search rejects a missing q with 400", async () => {
  const r = await kbSearch(makeReq("/api/kb-search?q="));
  assert.equal(r.status, 400, "missing q must 400");
});

test("/api/kb-search returns results + facet chips", async () => {
  await seed(sampleBundle());
  const r = await kbSearch(makeReq("/api/kb-search?q=cover%20letter&limit=8"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.results) && d.results.length > 0, "should return results");
  assert.equal(d.results[0].t, "Cover Letter Guide", "top result is the title match");
  // Facets should list the distinct courses and years present in the bundle.
  assert.ok(d.filters && Array.isArray(d.filters.courses), "filters.courses should be an array");
  assert.ok(d.filters.courses.includes("ELA 1 Gama"), "course facet should include ELA 1 Gama");
  assert.ok(d.filters.courses.includes("BEng Y1"), "course facet should include BEng Y1");
  assert.ok(d.filters.years.includes("2023-24"), "year facet should include 2023-24");
});

test("/api/kb-search course filter narrows results", async () => {
  await seed(sampleBundle());
  const r = await kbSearch(makeReq("/api/kb-search?q=cover%20letter&course=BEng%20Y1&limit=8"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.results.length >= 1, "BEng Y1 has a body-only cover-letter note");
  assert.ok(
    d.results.every((n) => n.course === "BEng Y1"),
    "every result must be the filtered course"
  );
  // The title match in ELA 1 Gama must be excluded by the course filter.
  assert.ok(!d.results.some((n) => n.course === "ELA 1 Gama"), "other courses excluded");
});

test("/api/kb-search year filter narrows results", async () => {
  await seed(sampleBundle());
  const r = await kbSearch(makeReq("/api/kb-search?q=STAR&year=2022-23&limit=8"));
  assert.equal(r.status, 200);
  const d = await r.json();
  // Only the 2022-23 STAR note should remain.
  assert.ok(d.results.every((n) => n.y === "2022-23"), "every result must be the filtered year");
  assert.ok(d.results.some((n) => n.t === "STAR Method"), "the 2022-23 STAR note is present");
});

test("/api/kb-search preserves original note index through facet filtering", async () => {
  await seed({
    version: 1,
    notes: [
      { t: "History algebra decoy", s: "Algebra", course: "History", y: "2024-25", x: "decoy" },
      { t: "Math algebra target", s: "Algebra", course: "Math", y: "2024-25", x: "target body" },
    ],
  });
  const r = await kbSearch(makeReq("/api/kb-search?q=algebra&course=Math&limit=8"));
  const d = await r.json();
  assert.equal(d.results.length, 1);
  assert.equal(d.results[0].noteIndex, 1, "filtered result must retain its bundle index");
  const nr = await kbNote(makeReq("/api/kb-note?id=" + d.results[0].noteIndex));
  assert.equal((await nr.json()).t, "Math algebra target", "opening result must resolve the target note");
});

test("searchNotes sorts all matches before applying the result limit", () => {
  const notes = [
    { t: "Zulu", s: "Algebra", y: "2024-25" },
    { t: "Alpha", s: "Algebra", y: "2024-25" },
    { t: "Beta", s: "Algebra", y: "2024-25" },
  ];
  const results = searchNotes(notes, "Algebra", { limit: 2, sortFn: makeSortFn("title") });
  assert.deepEqual(results.map((note) => note.t), ["Alpha", "Beta"]);
});

test("empty knowledge base returns empty results with empty:true", async () => {
  // Save an empty bundle, then query.
  await saveBundle({ version: 1, notes: [], years: [], courses: [] });
  const r = await kbSearch(makeReq("/api/kb-search?q=anything&limit=8"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.results.length, 0, "no results when DB empty");
  assert.equal(d.empty, true, "empty flag set");
  assert.ok(d.filters && d.filters.courses.length === 0, "no course facets when empty");
});

test("highlightSnippet wraps matched query tokens in <mark> and escapes HTML", () => {
  const out = highlightSnippet("Use the STAR method in your cover letter.", "STAR cover");
  assert.match(out, /<mark[^>]*>STAR<\/mark>/, "matched token STAR wrapped");
  assert.match(out, /<mark[^>]*>cover<\/mark>/, "matched token cover wrapped");
  assert.ok(out.includes("method in your"), "non-matched text preserved");
  // HTML in the snippet must be escaped, never interpreted.
  const evil = highlightSnippet("<script>alert(1)</script> cover", "cover");
  assert.ok(!evil.includes("<script>"), "raw html must be escaped");
  assert.ok(evil.includes("&lt;script&gt;"), "html entities present");
  // Empty / null snippet returns empty string.
  assert.equal(highlightSnippet("", "x"), "");
});

test("getBundle returns the seeded bundle", async () => {
  await seed(sampleBundle());
  const b = await getBundle();
  assert.ok(b && Array.isArray(b.notes) && b.notes.length === 3, "bundle persisted in memory");
});

// ---------------------------------------------------------------------------
// Feature A: clickable result cards -> full-note detail view.
// searchNotes must expose a stable noteIndex so the UI can fetch the whole note.
// ---------------------------------------------------------------------------
test("searchNotes attaches a stable noteIndex to each result", () => {
  const notes = sampleBundle().notes;
  const results = searchNotes(notes, "cover letter", { limit: 8 });
  assert.ok(results.length >= 1, "should find at least one note");
  // Every result must carry a noteIndex that indexes back into the source notes.
  for (const r of results) {
    assert.equal(typeof r.noteIndex, "number", "each result needs a numeric noteIndex");
    assert.strictEqual(r.noteIndex >= 0 && r.noteIndex < notes.length, true, "noteIndex in range");
    // The index must resolve back to the same note (title round-trips).
    assert.equal(notes[r.noteIndex].t, r.t, "noteIndex resolves to the same note title");
  }
});

test("/api/kb-note returns the full note by index", async () => {
  await seed(sampleBundle());
  const r = await kbSearch(makeReq("/api/kb-search?q=cover%20letter&limit=8"));
  const d = await r.json();
  const idx = d.results[0].noteIndex;
  assert.equal(typeof idx, "number", "search result carries noteIndex");

  const nr = await kbNote(makeReq("/api/kb-note?id=" + idx));
  assert.equal(nr.status, 200, "note detail should be 200");
  const note = await nr.json();
  assert.equal(note.t, d.results[0].t, "note detail title matches the search result");
  // The full body (x) must be present in the detail, not just a snippet.
  assert.ok(note.x && note.x.length > 0, "full note body returned");
});

test("/api/kb-note rejects out-of-range id with 404", async () => {
  await seed(sampleBundle());
  const nr = await kbNote(makeReq("/api/kb-note?id=9999"));
  assert.equal(nr.status, 404, "missing note must 404");
});

test("/api/kb-note with no id returns 400", async () => {
  const nr = await kbNote(makeReq("/api/kb-note"));
  assert.equal(nr.status, 400, "missing id must 400");
});

// ---------------------------------------------------------------------------
// Feature A: "Related notes" — cross-link notes by shared topic/course.
// relatedNotes() must return notes related to a given one (same course or
// topic), excluding itself, ranked by relevance. Exposed as /api/kb-related.
// ---------------------------------------------------------------------------
test("relatedNotes returns same-course / same-topic notes, excluding self", () => {
  const notes = sampleBundle().notes;
  // Find the "Cover Letter Guide" note: it shares course "ELA 1 Gama" with
  // nothing else in the sample, but shares topic "Writing"? No — it shares
  // the keyword "cover letter" in body with the Biology note. We assert the
  // contract generically instead of coupling to sample content.
  const target = notes[0];
  const related = relatedNotes(notes, target, { limit: 5 });
  assert.ok(Array.isArray(related), "relatedNotes must return an array");
  // The note itself must never appear in its own related list.
  assert.ok(!related.some((r) => r.t === target.t), "self excluded from related");
  // Every related note must actually relate (shared course OR shared topic OR
  // overlapping query tokens with the target's title/summary/body).
  for (const r of related) {
    const sameCourse = r.course && r.course === target.course;
    const sameTopic = r.topic && target.topic && r.topic === target.topic;
    assert.ok(sameCourse || sameTopic || !!r._score, "each related note must relate");
  }
});

test("relatedNotes limits the number of results", () => {
  const notes = sampleBundle().notes;
  const related = relatedNotes(notes, notes[0], { limit: 1 });
  assert.ok(related.length <= 1, "related count must not exceed limit");
});

test("/api/kb-related returns related notes for an index", async () => {
  await seed(sampleBundle());
  const sr = await kbSearch(makeReq("/api/kb-search?q=STAR&limit=8"));
  const sd = await sr.json();
  const idx = sd.results[0].noteIndex;
  const rr = await kbRelated(makeReq("/api/kb-related?id=" + idx + "&limit=5"));
  assert.equal(rr.status, 200, "related route should be 200");
  const rd = await rr.json();
  assert.ok(Array.isArray(rd.related), "related array present");
  // The STAR-method note shares its course (BEng Y1) with another note, so we
  // expect at least one cross-link to be surfaced.
  assert.ok(rd.related.length >= 1, "related notes should be found for a cross-linked note");
  // The returned related notes must not include the queried note itself.
  assert.ok(!rd.related.some((n) => n.noteIndex === idx), "self excluded");
});

test("/api/kb-related rejects out-of-range id with 404", async () => {
  await seed(sampleBundle());
  const rr = await kbRelated(makeReq("/api/kb-related?id=9999"));
  assert.equal(rr.status, 404, "out-of-range id must 404");
});

test("/api/kb-related with no id returns 400", async () => {
  const rr = await kbRelated(makeReq("/api/kb-related"));
  assert.equal(rr.status, 400, "missing id must 400");
});

// Regression guard: relatedNotes must stay FAST and produce SANE scores.
// A 2026-07-12 incident made /api/kb-related take ~6s on a 400-note corpus
// (loose fuzzy matcher scored every note in the thousands), which the cron
// loop's 5s curl timeout read as a hang (HTTP:000). This test fails loudly
// if the matcher regresses back to that behavior.
test("relatedNotes is fast and scores related notes sanely (regression guard)", () => {
  // Build a 400-note synthetic corpus with a clear same-course cluster so we
  // exercise realistic volume + real cross-links without a live vault.
  const notes = [];
  for (let i = 0; i < 400; i++) {
    notes.push({
      t: "Note " + i,
      s: "summary text " + (i % 5),
      x: "body content for note number " + i,
      course: "Course " + (i % 4),
      y: "2024-25",
      topic: "Topic " + (i % 3),
      p: "",
    });
  }
  const target = notes[60]; // shares Course 0 / Topic 0 with a cluster
  const t0 = Date.now();
  const rel = relatedNotes(notes, target, { limit: 5 });
  const dt = Date.now() - t0;
  assert.ok(dt < 2000, "relatedNotes(400 notes) must run well under the 5s loop timeout, took " + dt + "ms");
  assert.ok(rel.length >= 1, "should find at least one same-course/topic cross-link");
  // Sane scores: with exact-token overlap + course/topic bonuses, a 400-note
  // corpus should never produce scores in the thousands.
  const maxScore = Math.max(0, ...rel.map((r) => r._score));
  assert.ok(maxScore < 200, "related scores must be sane (<200), got max " + maxScore);
  for (const r of rel) {
    assert.ok(
      (r.course && r.course === target.course) ||
        (r.topic && r.topic === target.topic) ||
        r._score > 0,
      "each related note must have a real relation"
    );
  }
});

// ---------------------------------------------------------------------------
// Tutor source attribution: the tutor must SHOW WHICH NOTES it used, as
// clickable chips that jump to the note. The pure transform tutorSourceList()
// turns a raw list of retrieved notes into the chip descriptors the UI renders.
// ---------------------------------------------------------------------------
test("tutorSourceList builds clickable chip descriptors from retrieved notes", () => {
  const retrieved = [
    { t: "STAR Method", course: "BEng Y1", y: "2024-25", topic: "Interviews", noteIndex: 3 },
    { t: "Cover Letter Guide", course: "ELA 1 Gama", y: "2024-25", topic: "Writing", noteIndex: 7 },
  ];
  const list = tutorSourceList(retrieved);
  assert.ok(Array.isArray(list), "must return an array");
  assert.equal(list.length, 2, "one chip per retrieved note");
  // Each chip carries the data the UI needs to render + jump to the note.
  const first = list[0];
  assert.equal(first.noteIndex, 3, "chip keeps the note index for click-to-open");
  assert.ok(first.title && first.title.includes("STAR"), "chip shows the note title");
  assert.ok(first.subtitle && first.subtitle.includes("BEng Y1"), "chip shows course/year");
});

test("tutorSourceList de-duplicates notes by index and skips invalid entries", () => {
  const retrieved = [
    { t: "A", course: "C1", y: "2024", noteIndex: 5 },
    { t: "B", course: "C2", y: "2024", noteIndex: 5 }, // duplicate index -> dropped
    { t: "C", course: "C3", y: "2024", noteIndex: 9 },
    null,
    { t: "D" }, // no noteIndex -> dropped
  ];
  const list = tutorSourceList(retrieved);
  const indexes = list.map((c) => c.noteIndex).sort();
  assert.deepEqual(indexes, [5, 9], "only valid, unique indexes kept");
});

// ---------------------------------------------------------------------------
// Feature: "Did you mean" typo-tolerance (agent-proposed backlog).
// suggestCorrection(notes, query) returns a corrected spelling of the query
// when the original query hits nothing but a near-miss exists in the corpus
// (stem-edit distance on the first/few tokens). It must ONLY suggest when a
// confident correction exists (never a false "did you mean" on a good query),
// and must be fast (reuses the same index the search builds).
// ---------------------------------------------------------------------------
test("suggestCorrection returns a close real term when the query is a typo", () => {
  const notes = sampleBundle().notes;
  // "mitchondria" is a typo of "mitochondria" which appears in a note body.
  const s = suggestCorrection(notes, "mitchondria");
  assert.ok(s && typeof s === "string", "should suggest a correction string");
  assert.ok(/mitochondria/i.test(s), `suggestion should fix the typo, got: ${s}`);
});

test("suggestCorrection returns null for a query that already matches", () => {
  const notes = sampleBundle().notes;
  // "cover letter" is a real multi-word match in the corpus.
  const s = suggestCorrection(notes, "cover letter");
  assert.equal(s, null, "no suggestion when the query already matches");
});

test("suggestCorrection returns null for gibberish with no near-miss", () => {
  const notes = sampleBundle().notes;
  const s = suggestCorrection(notes, "zzqqxxqwqy zxvbnm");
  assert.equal(s, null, "no suggestion for pure gibberish");
});

test("/api/kb-search surfaces a didYouMean suggestion when a typo returns nothing", async () => {
  await seed(sampleBundle());
  const r = await kbSearch(makeReq("/api/kb-search?q=" + encodeURIComponent("mitchondria") + "&limit=8"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.results), "results array present");
  // Either the typo matches nothing (results empty) AND a suggestion exists,
  // or the loose fuzzy matcher already caught it (valid). The key contract:
  // when results are empty there must be a non-empty didYouMean hint.
  if (d.results.length === 0) {
    assert.ok(d.didYouMean && typeof d.didYouMean === "string" && d.didYouMean.length > 0,
      "empty result set must carry a didYouMean hint");
  }
});

// ---------------------------------------------------------------------------
// Feature: related-notes preview chip on each search result card.
// The note-detail modal already cross-links related notes; the SAME cross-link
// must be available from the search-results surface so a student can hop
// between related notes without opening each one. We expose
// relatedNotesPreview(notes, noteIndex, {limit}) returning a small ranked set
// (same shape as relatedNotes) so the UI can render compact chips under a card.
// ---------------------------------------------------------------------------
test("relatedNotesPreview returns related notes for a note index", () => {
  const notes = sampleBundle().notes;
  const target = notes[0]; // Cover Letter Guide
  const idx = notes.indexOf(target);
  const preview = relatedNotesPreview(notes, idx, { limit: 3 });
  assert.ok(Array.isArray(preview), "must return an array");
  // Must never include the note itself.
  assert.ok(!preview.some((r) => r.noteIndex === idx), "self excluded from preview");
  for (const r of preview) {
    const sameCourse = r.course && r.course === target.course;
    const sameTopic = r.topic && target.topic && r.topic === target.topic;
    assert.ok(sameCourse || sameTopic || !!r._score, "each preview note must relate");
  }
});

test("relatedNotesPreview is a wrapper that honours the same limit as relatedNotes", () => {
  const notes = sampleBundle().notes;
  const idx = 0;
  const preview = relatedNotesPreview(notes, idx, { limit: 1 });
  assert.ok(preview.length <= 1, "preview count must not exceed limit");
});

// ---------------------------------------------------------------------------
// Feature: "Browse by course" — a no-query entry point so students can
// discover notes without already knowing a search term. GET /api/kb-browse
// returns the distinct courses (with note counts) and, when a `course` is
// given, the notes in that course. Mirrors the facet shape / result shape the
// rest of the KB uses so the UI can reuse its rendering.
// ---------------------------------------------------------------------------
test("/api/kb-browse with no course lists distinct courses with note counts", async () => {
  await seed(sampleBundle());
  const r = await kbBrowse(makeReq("/api/kb-browse"));
  assert.equal(r.status, 200, "browse should be 200");
  const d = await r.json();
  assert.ok(Array.isArray(d.courses), "courses must be an array");
  // Two distinct courses in the sample bundle.
  assert.equal(d.courses.length, 2, "should list both courses");
  // Each course carries its note count + year facets.
  const ela = d.courses.find((c) => c.course === "ELA 1 Gama");
  assert.ok(ela, "ELA 1 Gama present");
  assert.equal(ela.count, 1, "ELA 1 Gama has 1 note");
  assert.deepEqual(ela.years, ["2023-24"], "ELA 1 Gama year facet");
  assert.equal(d.notes, undefined, "no notes list when no course selected");
});

test("/api/kb-browse?course=<name> returns that course's notes sorted by recency", async () => {
  await seed(sampleBundle());
  const r = await kbBrowse(makeReq("/api/kb-browse?course=" + encodeURIComponent("BEng Y1")));
  assert.equal(r.status, 200);
  const d = await r.json();
  // BEng Y1 has two notes (Random Biology Note, STAR Method).
  assert.ok(Array.isArray(d.notes) && d.notes.length === 2, "both BEng Y1 notes returned");
  assert.ok(d.notes.every((n) => n.course === "BEng Y1"), "every note is the requested course");
  // Result shape must match searchNotes so the UI reuses rendering.
  assert.ok("noteIndex" in d.notes[0] && "t" in d.notes[0], "result shape matches search");
  // Recency: 2023-24 note should rank above the 2022-23 note.
  const order = d.notes.map((n) => n.y);
  assert.ok(order.indexOf("2023-24") < order.indexOf("2022-23"), "newer notes first");
});

test("/api/kb-browse?course=<unknown> returns an empty notes list", async () => {
  await seed(sampleBundle());
  const r = await kbBrowse(makeReq("/api/kb-browse?course=" + encodeURIComponent("Nonexistent")));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.notes) && d.notes.length === 0, "unknown course -> no notes");
});

test("/api/kb-browse on a missing DB returns an empty courses list", async () => {
  await saveBundle({ version: 1, notes: [], years: [], courses: [] });
  const r = await kbBrowse(makeReq("/api/kb-browse"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.courses) && d.courses.length === 0, "no courses when DB empty");
});

// ---------------------------------------------------------------------------
// Vault ingestion (source:'vault') — makes the KB functional without a live
// Google token. Pure + Edge-safe; the fs walk happens in scripts/seed-vault.mjs.
// ---------------------------------------------------------------------------
test("bundleFromVault derives a summary `s` from the body (so search ×3 fires)", () => {
  const b = bundleFromVault([
    { t: "Mitochondria", x: "Mitochondria are the powerhouse of the cell. They produce ATP.", course: "Biology", y: "2025-26", topic: "Cells" },
  ]);
  assert.equal(b.notes.length, 1);
  const n = b.notes[0];
  assert.equal(n.s, "Mitochondria are the powerhouse of the cell.", "summary = first sentence");
  assert.equal(n.course, "Biology");
  assert.equal(n.y, "2025-26");
  assert.equal(n.topic, "Cells");
});

test("bundleFromVault falls back to 'Course · Topic: Title' when body is short", () => {
  const b = bundleFromVault([
    { t: "Exam tips", x: "", course: "Math", y: "2025-26", topic: "Algebra" },
  ]);
  assert.equal(b.notes[0].s, "Math · Algebra: Exam tips");
});

test("bundleFromVault produces multiple courses + years for the filter facets", () => {
  const b = bundleFromVault([
    { t: "A1", x: "body one", course: "Algebra", y: "2025-26" },
    { t: "G1", x: "body two", course: "Geometry", y: "2025-26" },
    { t: "A2", x: "body three", course: "Algebra", y: "2024-25" },
  ]);
  assert.equal(b.courses.length, 2, "two distinct courses");
  assert.equal(b.years.length, 2, "two distinct years");
});

test("bundleFromVault accepts title/body aliases and missing course", () => {
  const b = bundleFromVault([
    { title: "Untitled note", body: "Some content here about photosynthesis.", topicName: "Plants" },
  ]);
  assert.equal(b.notes[0].t, "Untitled note");
  assert.equal(b.notes[0].course, "Uncategorized");
  assert.ok(b.notes[0].s.startsWith("Some content"), "summary from body");
});

// ---------------------------------------------------------------------------
// appendBundle — chunked vault seeding must ACCUMULATE, not overwrite.
// ---------------------------------------------------------------------------
test("appendBundle merges notes across chunks and dedups by path", async () => {
  await saveBundle({ version: 1, notes: [], years: [], courses: [] });
  const { appendBundle } = await import("../api/kb-store.js");
  await appendBundle(bundleFromVault([
    { t: "A1", x: "body a", course: "Algebra", y: "2025-26", p: "2025-26/Algebra/A1" },
  ]));
  const mid = await getBundle();
  assert.equal(mid.notes.length, 1, "first chunk -> 1 note");

  await appendBundle(bundleFromVault([
    { t: "A1", x: "updated body", course: "Algebra", y: "2025-26", p: "2025-26/Algebra/A1" },
    { t: "G1", x: "body g", course: "Geometry", y: "2025-26", p: "2025-26/Geometry/G1" },
  ]));
  const fin = await getBundle();
  assert.equal(fin.notes.length, 2, "second chunk appends (not overwrite) -> 2 notes");
  const a1 = fin.notes.find((n) => n.p === "2025-26/Algebra/A1");
  assert.equal(a1.x, "updated body", "same-path note replaced, not duplicated");
  assert.equal(fin.courses.length, 2, "facets recomputed");
});

// ---------------------------------------------------------------------------
// Auth guard — POST /api/kb-scrape must reject unauthenticated writes.
// ---------------------------------------------------------------------------
test("/api/kb-scrape rejects unauthenticated writes (401)", async () => {
  const kbScrape = (await import("../api/kb-scrape.js")).default;
  const before = process.env.KB_WRITE_TOKEN;
  delete process.env.KB_WRITE_TOKEN; // simulate: no shared secret configured
  try {
    const res = await kbScrape(new Request("http://localhost/api/kb-scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "vault", notes: [{ t: "x", x: "y", course: "C", y: "2025", p: "p" }] }),
    }));
    assert.equal(res.status, 401, "no auth -> 401");
  } finally {
    if (before !== undefined) process.env.KB_WRITE_TOKEN = before;
  }
});

test("/api/kb-scrape accepts a matching X-KB-Write-Token", async () => {
  const kbScrape = (await import("../api/kb-scrape.js")).default;
  const before = process.env.KB_WRITE_TOKEN;
  process.env.KB_WRITE_TOKEN = "test-secret-123";
  try {
    const res = await kbScrape(new Request("http://localhost/api/kb-scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KB-Write-Token": "test-secret-123" },
      body: JSON.stringify({ source: "vault", notes: [{ t: "AuthOK", x: "body", course: "Auth", y: "2025", p: "auth/AuthOK" }] }),
    }));
    assert.equal(res.status, 200, "valid write token -> 200");
  } finally {
    delete process.env.KB_WRITE_TOKEN;
    if (before !== undefined) process.env.KB_WRITE_TOKEN = before;
  }
});

test("/api/kb-scrape rejects a WRONG X-KB-Write-Token (401)", async () => {
  const kbScrape = (await import("../api/kb-scrape.js")).default;
  const before = process.env.KB_WRITE_TOKEN;
  process.env.KB_WRITE_TOKEN = "test-secret-123";
  try {
    const res = await kbScrape(new Request("http://localhost/api/kb-scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KB-Write-Token": "wrong" },
      body: JSON.stringify({ source: "vault", notes: [{ t: "x", x: "y", course: "C", y: "2025", p: "p" }] }),
    }));
    assert.equal(res.status, 401, "wrong token -> 401");
  } finally {
    delete process.env.KB_WRITE_TOKEN;
    if (before !== undefined) process.env.KB_WRITE_TOKEN = before;
  }
});

// ---------------------------------------------------------------------------
// Resumable Classroom scrape — list + per-course modes (no live Google token).
// Stubs global fetch to emulate the Classroom API so we exercise the new
// bounded, incremental path that avoids the Vercel Edge 10s 504 timeout.
// ---------------------------------------------------------------------------
test("classroom mode:'list' returns course ids, mode:'course' appends one course", async () => {
  const kbScrape = (await import("../api/kb-scrape.js")).default;
  const realFetch = globalThis.fetch;
  const beforeTok = process.env.KB_WRITE_TOKEN;
  process.env.KB_WRITE_TOKEN = "test-classroom-secret"; // simulate loop/seed secret
  const FAKE = {
    "/v1/courses": { courses: [
      { id: "c1", name: "Algebra" },
      { id: "c2", name: "Geometry" },
    ] },
    "/v1/courses/c1/courseWork": { courseWork: [{ id: "w1", title: "Quadratics" }] },
    "/v1/courses/c2/courseWork": { courseWork: [{ id: "w2", title: "Triangles" }] },
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    // Match most-specific key first (courseWork URLs also contain "/v1/courses").
    const keys = Object.keys(FAKE).sort((a, b) => b.length - a.length);
    for (const key of keys) if (u.includes(key)) return { ok: true, json: async () => FAKE[key] };
    return { ok: true, json: async () => ({ topic: [], courseWorkMaterials: [], announcements: [], studentSubmissions: [] }) };
  };
  try {
    const authHdr = { "Content-Type": "application/json", "X-KB-Write-Token": "test-classroom-secret" };
    // list
    const listRes = await kbScrape(new Request("http://localhost/api/kb-scrape", {
      method: "POST", headers: authHdr,
      body: JSON.stringify({ source: "classroom", mode: "list", authToken: "fake" }),
    }));
    assert.equal(listRes.status, 200, "list mode -> 200");
    const listJson = await listRes.json();
    assert.equal(listJson.courses.length, 2, "should list 2 courses");

    // per-course append (c1)
    const c1Res = await kbScrape(new Request("http://localhost/api/kb-scrape", {
      method: "POST", headers: authHdr,
      body: JSON.stringify({ source: "classroom", mode: "course", courseId: "c1", authToken: "fake" }),
    }));
    assert.equal(c1Res.status, 200, "course c1 -> 200");
    const c1Json = await c1Res.json();
    assert.ok(c1Json.notes >= 1, "c1 should produce >=1 note");
    assert.equal(c1Json.courseId, "c1", "echoes courseId");

    // per-course append (c2)
    const c2Res = await kbScrape(new Request("http://localhost/api/kb-scrape", {
      method: "POST", headers: authHdr,
      body: JSON.stringify({ source: "classroom", mode: "course", courseId: "c2", authToken: "fake" }),
    }));
    assert.equal(c2Res.status, 200, "course c2 -> 200");
    const c2Json = await c2Res.json();
    assert.ok(c2Json.notes >= 1, "c2 should produce >=1 note");

    // the shared bundle should now hold both courses' notes (incremental)
    const { getBundle } = await import("../api/kb-store.js");
    const b = await getBundle();
    assert.ok(b.notes.length >= 2, "bundle accumulated notes from both courses (incremental append)");
    assert.ok(b.courses.length >= 2, "facets reflect both courses");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.KB_WRITE_TOKEN;
    if (beforeTok !== undefined) process.env.KB_WRITE_TOKEN = beforeTok;
  }
});

// ---------------------------------------------------------------------------
// Assignment material + student submission inclusion (the "scrape the actual
// assignment materials" requirement). Locks the contract that a coursework note
// renders BOTH the teacher's posted materials AND the student's submitted-file
// link AND a deep link back to the assignment in Classroom.
// ---------------------------------------------------------------------------
test("bundleFromRaw includes teacher materials, student submission links, and assignment deep-link", async () => {
  const { bundleFromRaw } = await import("../archive-builder.js");
  const raw = {
    courses: [{ id: "c1", name: "Algebra II", creationTime: "2024-09-01T00:00:00Z" }],
    courseData: {
      c1: {
        topics: [{ topicId: "t1", name: "Quadratics" }],
        courseWork: [{
          id: "w1", title: "Worksheet", description: "Do it.", topicId: "t1",
          dueDate: { year: 2024, month: 10, day: 15 }, maxPoints: 20,
          alternateLink: "https://classroom.google.com/c/ABC/w/1",
          materials: [{ driveFile: { title: "Worksheet PDF", alternateLink: "https://classroom.google.com/c/ABC/d/DEF" } }],
        }],
        courseWorkMaterials: [{ id: "m1", title: "Ref", materials: [{ link: { title: "Guide", url: "https://example.com/g" } }] }],
        announcements: [{ id: "a1", text: "Test", creationTime: "2024-10-01T10:00:00Z", alternateLink: "https://classroom.google.com/c/ABC/a/1" }],
        submissions: [{
          courseWorkId: "w1", state: "TURNED_IN", assignedGrade: 18,
          assignmentSubmission: { attachments: [{ driveFile: { title: "mine.pdf", alternateLink: "https://classroom.google.com/c/SUB/d/W" } }] },
        }],
      },
    },
  };
  const b = bundleFromRaw(raw);
  const cw = b.notes.find((n) => n.t === "Worksheet");
  assert.ok(cw, "coursework note present");
  // Teacher materials
  assert.ok(/Teacher materials/.test(cw.x), "teacher materials heading present");
  assert.ok(cw.x.includes("https://classroom.google.com/c/ABC/d/DEF"), "teacher Drive link present");
  // Student submission link
  assert.ok(/Your submission/.test(cw.x) && /What you submitted/.test(cw.x), "student submission section present");
  assert.ok(cw.x.includes("https://classroom.google.com/c/SUB/d/W"), "student submitted-file link present");
  // Deep link to the assignment page
  assert.ok(cw.x.includes("[Open assignment in Classroom](https://classroom.google.com/c/ABC/w/1)"), "assignment deep-link present");
  // CourseWorkMaterials (teacher-posted reference material) also ingested
  const ref = b.notes.find((n) => n.t === "Ref");
  assert.ok(ref && ref.x.includes("https://example.com/g"), "courseWorkMaterials ingested as a note");
});

// ---------------------------------------------------------------------------
// Note body link rendering — teacher/submission markdown links must become
// real clickable <a> tags in the KB/archive note view, and unsafe protocols
// (javascript:, data:) must be neutralized. Guards the "make links clickable"
// requirement.
// ---------------------------------------------------------------------------
test("renderLightMarkdown turns [text](url) into clickable, safe <a>", async () => {
  const { renderLightMarkdown } = await import("../archive.js");
  const md = "Teacher materials:\n- [Worksheet PDF](https://classroom.google.com/c/ABC/d/DEF)\n\n[Open assignment in Classroom](https://classroom.google.com/c/ABC/w/1)\n\n[evil](javascript:alert(1))";
  const html = renderLightMarkdown(md);
  // clickable anchors with safe target + rel
  assert.ok(html.includes('href="https://classroom.google.com/c/ABC/d/DEF"'), "teacher link is an <a> with real href");
  assert.ok(html.includes('target="_blank"'), "links open in a new tab");
  assert.ok(html.includes('rel="noopener noreferrer"'), "links are rel-isolated");
  assert.ok(html.includes('title="https://classroom.google.com/c/ABC/d/DEF"'), "link has a hover title (preview of destination)");
  // unsafe protocol neutralized
  assert.ok(html.includes('href="#"'), "javascript: link neutralized to #");
  assert.ok(!/javascript:/.test(html.replace(/href="#"/g, "")), "no raw javascript: href survives");
});

// ---------------------------------------------------------------------------
// Regression (owner requests #8/#10 — assignment/material readability): real
// teacher-material links carry a bracketed filename in the label, e.g.
//   [[Template] Domáca úloha - zhodnosť](https://docs.google.com/…)
// The old link regex used [^\]]+ for the label, which stopped at the FIRST ']'
// inside "[Template]" — so the whole link failed to match and rendered as raw
// literal markdown text (visible "[[Template] …](https://…)"), exactly the
// "raw markup shows as text" bug the owner reported. The label matcher must
// tolerate inner brackets so the link becomes a real clickable <a>.
// ---------------------------------------------------------------------------
test("renderLightMarkdown renders links whose label contains [brackets]", async () => {
  const { renderLightMarkdown } = await import("../archive.js");
  const url = "https://docs.google.com/document/d/1teHw9/edit";
  const md = `Teacher materials:\n- [[Template] Domáca úloha - zhodnosť](${url})`;
  const html = renderLightMarkdown(md);
  // The link must become a real anchor with the real href…
  assert.ok(html.includes(`href="${url}"`), "bracketed-label link becomes an <a> with real href");
  // …and its human label (including the [Template] part) is shown as text.
  assert.ok(html.includes("[Template] Domáca úloha - zhodnosť"), "bracketed label text preserved inside the <a>");
  // No raw markdown link syntax should leak through as visible text.
  assert.ok(!html.includes(`](${url})`), "no raw markdown link syntax leaks into the output");
});

// ---------------------------------------------------------------------------
// KB EXPORT fitness — the owner-requested export must carry the actual note
// CONTENT (body `x` and summary `s`), not just an index of metadata. A
// "knowledge base" export that omits the bodies is worthless to a student.
// These regression tests guard that contract for both Markdown and CSV.
// ---------------------------------------------------------------------------
test("bundleToMarkdown includes note body + summary, not just metadata", async () => {
  const { bundleToMarkdown } = await import("../kb.js");
  assert.ok(typeof bundleToMarkdown === "function", "bundleToMarkdown is exported");
  const bundle = {
    generatedAt: new Date().toISOString(),
    notes: [{
      t: "Cover Letter Guide",
      s: "How to write a strong cover letter that lands interviews.",
      x: "A cover letter should open with a hook and show fit. Use the STAR method.",
      course: "ELA 1 Gama",
      y: "2023-24",
      topic: "Writing",
      p: "vault/ELA/Cover.md",
      tags: ["writing", "jobs"],
    }],
  };
  const md = bundleToMarkdown(bundle);
  assert.ok(md.includes("Cover Letter Guide"), "title present");
  assert.ok(md.includes("ELA 1 Gama"), "course grouping present");
  assert.ok(md.includes("A cover letter should open with a hook"), "BODY content present in markdown");
  assert.ok(md.includes("How to write a strong cover letter"), "SUMMARY content present in markdown");
});

// ---------------------------------------------------------------------------
// Regression (owner request #9 — related notes must not crowd with irrelevant
// boilerplate): a giant course "Announcements" note is full of common words
// ("classroom", "students", "assignment", "thank you") that overlap via raw
// token counts against EVERY other note — so it scores into the hundreds and
// drowns out genuinely relevant same-course / same-topic cross-links. The fix
// filters stopwords from the overlap signal so boilerplate can't dominate.
// ---------------------------------------------------------------------------
test("relatedNotes ranks a genuinely related same-course note above generic boilerplate", () => {
  // ~2000-word boilerplate of common words, like a real "Announcements" dump.
  const boiler = Array.from({ length: 400 }, (_, i) => `classroom students assignment teacher thank you please note homework`).join(" ");
  const notes = [
    // target: a small, specific Physics note — but like every real note pulled
    // from Classroom it also carries common vocabulary (assignment, classroom).
    { t: "Quantum entanglement", s: "Notes on quantum entanglement.", x: "Quantum entanglement and superposition lecture. Please submit the assignment on Classroom.", course: "Physics", y: "2025-26", topic: "Quantum" },
    // genuinely related: same course + same topic, specific vocabulary.
    { t: "Quantum superposition", s: "Quantum superposition examples.", x: "Quantum superposition and entanglement worked examples.", course: "Physics", y: "2025-26", topic: "Quantum" },
    // giant generic boilerplate (different course) — must NOT outrank the above.
    { t: "Physics - Announcements", s: "", x: boiler, course: "Other", y: "2025-26", topic: "Announcements" },
  ];
  const target = notes[0];
  const rel = relatedNotes(notes, target, { limit: 5 });
  const relatedIdx = rel.findIndex((r) => r.t === "Quantum superposition");
  const boilerIdx = rel.findIndex((r) => r.t === "Physics - Announcements");
  // The genuinely related same-course note MUST appear in the results.
  assert.ok(relatedIdx !== -1, "genuinely related note must appear");
  // The giant generic boilerplate must NOT outrank it (ideally not appear at all).
  assert.ok(
    boilerIdx === -1 || relatedIdx < boilerIdx,
    "genuinely related same-course note must outrank generic boilerplate"
  );
});

test("bundleToCsv includes body + summary columns carrying real content", async () => {
  const { bundleToCsv } = await import("../kb.js");
  assert.ok(typeof bundleToCsv === "function", "bundleToCsv is exported");
  const bundle = {
    notes: [{
      t: "Cover Letter Guide",
      s: "How to write a strong cover letter that lands interviews.",
      x: "A cover letter should open with a hook and show fit. Use the STAR method.",
      course: "ELA 1 Gama",
      y: "2023-24",
      topic: "Writing",
      p: "vault/ELA/Cover.md",
      tags: ["writing", "jobs"],
    }],
  };
  const csv = bundleToCsv(bundle);
  const header = csv.split("\n")[0];
  assert.ok(header.includes("summary"), "summary column exists");
  assert.ok(header.includes("body"), "body column exists");
  assert.ok(header.includes("path"), "path column exists (not mislabeled as body)");
  const row = csv.split("\n")[1] || "";
  assert.ok(row.includes("A cover letter should open with a hook"), "BODY content present in CSV row");
  assert.ok(row.includes("How to write a strong cover letter"), "SUMMARY content present in CSV row");
});

// ---------------------------------------------------------------------------
// Regression (owner request #2 — every course must be reachable as a filter):
// the filter UI used to hard-cap at the first 24 courses, so a ~38-course KB
// left ~14 courses (e.g. the alphabetically-later ones) UNREACHABLE as a
// course filter. kbFilterModel must return ALL courses (no silent truncation)
// plus the years, so the filter UI can render a complete course selector.
// This is a pure model function (no DOM) so it stays unit-testable.
// ---------------------------------------------------------------------------
test("kbFilterModel returns every course + year without truncating", () => {
  assert.ok(typeof kbFilterModel === "function", "kbFilterModel is exported");
  // 40 distinct courses — exceeds the old 24-chip cap that hid courses.
  const courses = Array.from({ length: 40 }, (_, i) => `Course ${String(i).padStart(2, "0")}`);
  const years = ["2023-24", "2024-25", "2025-26", "undated"];
  const filters = { courses, years };
  const model = kbFilterModel(filters);
  // No truncation: all 40 courses must be present, not just the first 24.
  assert.strictEqual(model.courses.length, 40, "all courses returned (no cap/truncation)");
  assert.deepStrictEqual(model.years, years, "all years returned");
  // Active state must round-trip so the UI can mark the selected chip.
  const withActive = kbFilterModel(filters, { course: "Course 39", year: "2025-26" });
  assert.strictEqual(withActive.activeCourse, "Course 39", "active course passed through");
  assert.strictEqual(withActive.activeYear, "2025-26", "active year passed through");
  // The last (alphabetically latest) course must be reachable.
  assert.ok(model.courses.includes("Course 39"), "last course is reachable as a filter");
});

// ---------------------------------------------------------------------------
// Focus area 7 — KB sorting & filtering by kind / year / class / class-type
// (family) + an explicit sort order. The filter model must carry the new
// facets (kinds, families) and a default sort so the UI can render a complete
// type + class-type selector and a sort dropdown, and round-trip active state.
// ---------------------------------------------------------------------------
test("kbFilterModel returns kinds + families + default sort and round-trips active state", () => {
  assert.ok(typeof kbFilterModel === "function", "kbFilterModel is exported");
  const filters = {
    courses: ["ELA 1", "BEng Y1"],
    years: ["2023-24", "2025-26"],
    kinds: ["note", "announcements"],
    families: ["Language", "Engineering"],
  };
  const m = kbFilterModel(filters);
  assert.deepStrictEqual(m.kinds, ["note", "announcements"], "kinds facet returned");
  assert.deepStrictEqual(m.families, ["Language", "Engineering"], "families facet returned");
  assert.strictEqual(m.sort, "relevance", "default sort is relevance");
  const active = kbFilterModel(filters, {
    kind: "announcements",
    family: "Engineering",
    sort: "recency",
  });
  assert.strictEqual(active.activeKind, "announcements", "active kind passed through");
  assert.strictEqual(active.activeFamily, "Engineering", "active family passed through");
  assert.strictEqual(active.sort, "recency", "active sort passed through");
});

// /api/kb-search must surface kind + family facets and narrow by `kind`.
test("/api/kb-search filters by kind and returns the kind facet", async () => {
  await saveBundle({
    version: 1,
    source: "bundle",
    notes: [
      { t: "Shared note", kind: "note", course: "C1", y: "2025-26", s: "", x: "shared body" },
      { t: "Shared announcement", kind: "announcements", course: "C1", y: "2025-26", s: "", x: "shared body" },
    ],
  });
  const r = await kbSearch(makeReq("/api/kb-search?q=shared&kind=announcements"));
  const d = await r.json();
  assert.strictEqual(d.results.length, 1, "only the matching kind is returned");
  assert.strictEqual(d.results[0].t, "Shared announcement", "the announcement note is returned");
  assert.ok(d.filters.kinds.includes("announcements"), "announcements kind facet surfaced");
  assert.ok(d.filters.kinds.includes("note"), "note kind facet surfaced");
});

// /api/kb-search must narrow by `family` when notes carry a family.
test("/api/kb-search filters by family and returns the family facet", async () => {
  await saveBundle({
    version: 1,
    source: "bundle",
    notes: [
      { t: "Lang note", kind: "note", course: "ELA 1", family: "Language", y: "2025-26", s: "", x: "common term" },
      { t: "Eng note", kind: "note", course: "BEng Y1", family: "Engineering", y: "2025-26", s: "", x: "common term" },
    ],
  });
  const r = await kbSearch(makeReq("/api/kb-search?q=common&family=Engineering"));
  const d = await r.json();
  assert.strictEqual(d.results.length, 1, "only the matching family is returned");
  assert.strictEqual(d.results[0].t, "Eng note", "the engineering note is returned");
  assert.ok(d.filters.families.includes("Engineering"), "Engineering family facet surfaced");
  assert.ok(d.filters.families.includes("Language"), "Language family facet surfaced");
});

// /api/kb-search must honour an explicit sort order on the matched set.
test("/api/kb-search honour sort=recency (newest year first)", async () => {
  await saveBundle({
    version: 1,
    source: "bundle",
    notes: [
      { t: "Old note", kind: "note", course: "C", y: "2022-23", s: "", x: "alpha beta keyword" },
      { t: "New note", kind: "note", course: "C", y: "2025-26", s: "", x: "alpha beta keyword" },
    ],
  });
  const r = await kbSearch(makeReq("/api/kb-search?q=keyword&sort=recency"));
  const d = await r.json();
  assert.strictEqual(d.results.length, 2, "both matched notes returned");
  assert.strictEqual(d.results[0].t, "New note", "recency sort puts the newest year first");
});

test("/api/kb-search honour sort=title (alphabetical)", async () => {
  await saveBundle({
    version: 1,
    source: "bundle",
    notes: [
      { t: "Zebra note", kind: "note", course: "C", y: "2025-26", s: "", x: "cat dog keyword" },
      { t: "Apple note", kind: "note", course: "C", y: "2025-26", s: "", x: "cat dog keyword" },
    ],
  });
  const r = await kbSearch(makeReq("/api/kb-search?q=keyword&sort=title"));
  const d = await r.json();
  assert.strictEqual(d.results[0].t, "Apple note", "title sort is alphabetical");
});

test("/api/kb-search honour sort=course (grouped by class)", async () => {
  await saveBundle({
    version: 1,
    source: "bundle",
    notes: [
      { t: "Zeta note", kind: "note", course: "Zeta", y: "2025-26", s: "", x: "fish keyword" },
      { t: "Alpha note", kind: "note", course: "Alpha", y: "2025-26", s: "", x: "fish keyword" },
    ],
  });
  const r = await kbSearch(makeReq("/api/kb-search?q=keyword&sort=course"));
  const d = await r.json();
  assert.strictEqual(d.results[0].course, "Alpha", "course sort groups by class name");
});

// appendBundle must derive a `family` for each note from its course name so the
// family facet is populated on the live corpus (notes arrive without family).
test("appendBundle derives a family per note from its course name", async () => {
  const { appendBundle } = await import("../api/kb-store.js");
  await appendBundle({
    source: "vault",
    notes: [{ t: "X", kind: "note", course: "BEng Y1", y: "2025-26", s: "", x: "" }],
  });
  const b = await getBundle();
  const n = b.notes.find((nn) => nn.t === "X");
  assert.ok(n, "note ingested");
  assert.strictEqual(n.family, "Engineering", "family derived from 'BEng' course prefix");
});

// ---------------------------------------------------------------------------
// Regression (owner request #11 — fold class materials into sprints/topics):
// opening a course used to dump ALL notes (e.g. 343 for "Matematika 1") in one
// flat list, which is overwhelming. groupCourseNotesBySprint groups the notes
// by their `topic` field, detects "Šprint N …" sprint topics, and returns an
// ORDERED list of collapsible groups (sprints first, in numeric order; other
// topics after; untopiced notes last). Each group carries its notes so the UI
// can render a Course > Sprint/Topic accordion instead of a 100+ item dump.
// Pure function (no DOM) so it stays unit-testable.
// ---------------------------------------------------------------------------
test("groupCourseNotesBySprint folds notes into ordered sprint/topic groups", () => {
  assert.ok(typeof groupCourseNotesBySprint === "function", "groupCourseNotesBySprint is exported");
  const notes = [
    { t: "N1", topic: "Šprint 2 - Výrazy, percentá" },
    { t: "N2", topic: "Description" },
    { t: "N3", topic: "Šprint 5 - geometria" },
    { t: "N4", topic: "Šprint 2 - Výrazy, percentá" },
    { t: "N5", topic: null },            // untopiced -> "Other" group
    { t: "N6", topic: "Šprint 10 - later" }, // numeric order: 10 after 5, not lexical
    { t: "N7", topic: "Notes" },
  ];
  const groups = groupCourseNotesBySprint(notes);
  // Every note must be accounted for (nothing silently dropped).
  const total = groups.reduce((n, g) => n + g.notes.length, 0);
  assert.strictEqual(total, notes.length, "all notes land in exactly one group");
  // Group counts must match the note tallies.
  const byKey = Object.fromEntries(groups.map((g) => [g.label, g]));
  assert.strictEqual(byKey["Šprint 2 - Výrazy, percentá"].count, 2, "sprint 2 has 2 notes");
  // Sprints come first, in NUMERIC order (2, 5, 10) — not lexical (10 < 2).
  const sprintLabels = groups.filter((g) => g.isSprint).map((g) => g.sprintNum);
  assert.deepStrictEqual(sprintLabels, [2, 5, 10], "sprints ordered numerically, not lexically");
  // Sprints must precede non-sprint topics in the ordered output.
  const firstNonSprint = groups.findIndex((g) => !g.isSprint);
  const lastSprint = groups.reduce((idx, g, i) => (g.isSprint ? i : idx), -1);
  assert.ok(lastSprint < firstNonSprint, "all sprint groups come before non-sprint groups");
  // Untopiced notes are collected into a single trailing "Other" group.
  const other = groups.find((g) => g.notes.some((n) => n.t === "N5"));
  assert.ok(other && !other.isSprint, "untopiced note lands in a non-sprint group");
});

// ---------------------------------------------------------------------------
// Regression (owner request #8): full body preserved, not truncated.
// bundleFromVault used to cap each note body at 1500 chars, silently chopping
// ~63% of the real vault (avg 3278 chars; some 100k+). The cap was removed so
// every note — even the long 1/100 ones — loads completely in the detail view.
// KV sharding (kb-store.js planShards) keeps each value under the per-value
// size limit instead, so removing the cap is safe.
// ---------------------------------------------------------------------------
test("bundleFromVault preserves the FULL body (no 1500-char truncation)", () => {
  const longBody = "A".repeat(5000) + "\n\nSecond paragraph with **bold** and a [link](https://example.com).";
  const bundle = bundleFromVault([
    { t: "Long Assignment", x: longBody, course: "Math", y: "2025", topic: "Algebra" },
  ]);
  assert.strictEqual(bundle.notes.length, 1, "one note built");
  const note = bundle.notes[0];
  // The body must be stored in full — length must equal the original, NOT 1500.
  assert.strictEqual(note.x.length, longBody.length, "body length must match the source (no truncation)");
  assert.ok(note.x.startsWith("A".repeat(5000)), "leading content preserved");
  assert.ok(note.x.includes("Second paragraph"), "trailing content preserved");
  assert.ok(!note.x.endsWith("…"), "must not be truncated with an ellipsis");
});

test("saveBundle shards large bodies without losing content", async () => {
  // Build a bundle whose total body size far exceeds a single 1MB KV value.
  const notes = [];
  for (let i = 0; i < 300; i++) {
    notes.push({ t: `Note ${i}`, x: "B".repeat(8000), course: "C", y: "2025", topic: "T" });
  }
  await saveBundle({ version: 1, source: "vault", generatedAt: new Date().toISOString(), years: ["2025"], courses: [{ name: "C" }], notes });
  const reloaded = await getBundle();
  assert.strictEqual(reloaded.notes.length, 300, "all notes survive a shard round-trip");
  assert.ok(reloaded.notes.every((n) => n.x.length === 8000), "no body lost in sharding");
});

// ---------------------------------------------------------------------------
// Regression (owner request #10): richer markdown renders correctly and safely.
// renderRichMarkdown adds blockquotes, strikethrough, and GitHub tables on top
// of the safe light pass. It must NEVER reintroduce raw, unescaped user HTML
// (XSS-safe) and must render the common constructs instead of leaking raw text.
// ---------------------------------------------------------------------------
test("renderRichMarkdown renders blockquotes, strikethrough, and tables", () => {
  const md = [
    "> A wise note",
    "This is ~~wrong~~ corrected.",
    "",
    "| Name | Score |",
    "| --- | --- |",
    "| Ada | 95 |",
    "| Bob | 80 |",
  ].join("\n");
  const html = renderRichMarkdown(md);
  assert.ok(html.includes("<blockquote>A wise note</blockquote>"), "blockquote rendered");
  assert.ok(html.includes("<del>wrong</del>"), "strikethrough rendered");
  assert.ok(html.includes("<table class=\"md-table\">"), "table wrapper rendered");
  assert.ok(html.includes("<th>Name</th>") && html.includes("<td>Ada</td>"), "table cells rendered");
});

test("renderRichMarkdown stays XSS-safe (escapes raw HTML)", () => {
  const evil = "<img src=x onerror=alert(1)> **bold**";
  const html = renderRichMarkdown(evil);
  assert.ok(!html.includes("<img src=x"), "raw img tag must be escaped, not injected");
  assert.ok(html.includes("&lt;img"), "angle brackets escaped to entities");
  assert.ok(html.includes("<strong>bold</strong>"), "legitimate markdown still renders");
});

// ---------------------------------------------------------------------------
// Regression (owner request #10, evidence-driven): the REAL corpus is Obsidian
// markdown. An export scan of the live bundle (3990 notes) shows the dominant
// constructs are `[[wikilinks]]` (2940 notes) and `> [!callout]` blocks like
// `> [!summary]` (2731 notes) — NOT GitHub tables (12 notes). Before this fix
// renderRichMarkdown leaked `[[path|label]]` and `[!summary]` as literal visible
// text, which is exactly the "raw markup as visible text" the owner reported.
// ---------------------------------------------------------------------------
test("renderRichMarkdown renders [[wikilinks]] as readable labels (no literal [[ ]])", () => {
  // Piped form: label after the |. Plain form: the path tail is the label.
  const md = [
    "See [[2025-26/vault/Business/Zadania/08_Zadanie|Analyza Lego]] for details.",
    "Also [[Simple Note]] and [[a/b/c/Deep Note]].",
  ].join("\n");
  const html = renderRichMarkdown(md);
  assert.ok(!html.includes("[["), "no literal opening [[ should leak");
  assert.ok(!html.includes("]]"), "no literal closing ]] should leak");
  assert.ok(html.includes("Analyza Lego"), "piped wikilink shows its label");
  assert.ok(html.includes("Simple Note"), "plain wikilink shows its name");
  assert.ok(html.includes("Deep Note") && !html.includes("a/b/c/Deep Note"),
    "plain wikilink with a path shows only the tail as label");
});

test("renderRichMarkdown renders Obsidian > [!callout] blocks without leaking [!type]", () => {
  const md = [
    "> [!summary]",
    "> Record revenue of 74.3 billion DKK with **13% growth**.",
    "> Second summary line.",
  ].join("\n");
  const html = renderRichMarkdown(md);
  assert.ok(!html.includes("[!summary]"), "the [!summary] marker must not leak as literal text");
  assert.ok(html.includes("Record revenue"), "callout body content is preserved");
  assert.ok(html.includes("<strong>13% growth</strong>"), "inline markdown inside a callout still renders");
  assert.ok(/callout|blockquote/.test(html), "callout wrapped in a styled container");
});

// XSS safety: a wikilink label/path containing HTML must NEVER decode back to
// raw, executable markup. renderLightMarkdown escapes source first; our
// transform re-escapes the extracted label, so even "<script>" becomes inert
// entities (double-escaped), never a live tag.
test("renderRichMarkdown [[wikilinks]] cannot inject raw HTML (XSS-safe)", () => {
  const html = renderRichMarkdown('See [[Note|<img src=x onerror=alert(1)>]] end');
  assert.ok(!html.includes("<img"), "no live <img> tag from a wikilink label");
  assert.ok(!html.includes("<script>"), "no live <script> from a wikilink");
  assert.ok(html.includes("&lt;img"), "label HTML is escaped to entities");
});

// Callout structure: the title must appear exactly once (in .callout-title,
// not duplicated into the body) and multi-line bodies must not leave dangling
// </p><p> artifacts.
test("renderRichMarkdown callout has a single title and clean body (no dangling tags)", () => {
  const md = ["> [!info]", "> Link to [[Foo/Bar|Baz]] inside callout.", "> **bold** text."].join("\n");
  const html = renderRichMarkdown(md);
  assert.ok(!html.includes("[!info]"), "callout marker stripped");
  const titleCount = (html.match(/Info/g) || []).length;
  assert.equal(titleCount, 1, "title appears exactly once (no duplication)");
  assert.ok(!/callout-body\">[^<]*<\/p>/.test(html), "no dangling </p> inside callout body");
  assert.ok(html.includes("Baz"), "wikilink inside callout still renders");
  assert.ok(html.includes("<strong>bold</strong>"), "inline markdown inside callout renders");
});

test("renderAssignmentDescription preserves full markdown assignment content", () => {
  const tail = "This final paragraph must remain reachable after the opening section.";
  const md = `# Assignment\n\n**Submit the complete draft.**\n\n${"Details that must not be clipped. ".repeat(80)}\n\n${tail}`;
  const html = renderAssignmentDescription(md);
  assert.match(html, /<h1>Assignment<\/h1>/);
  assert.match(html, /<strong>Submit the complete draft\.<\/strong>/);
  assert.ok(html.includes(tail), "the full description tail must be rendered");
  assert.ok(!html.includes("**Submit"), "markdown markers must not leak into visible HTML");
});

test("renderAssignmentDescription escapes HTML in callout titles", () => {
  const html = renderAssignmentDescription("> [!warning] <img src=x onerror=alert(1)>\n> Safe body");
  assert.ok(!html.includes("<img"), "callout titles must not create live HTML elements");
  assert.ok(html.includes("&lt;img"), "escaped callout title text should remain visible");
});

test("renderAssignmentDescription escapes HTML in table cells", () => {
  const html = renderAssignmentDescription("| Item | Value |\n| --- | --- |\n| Safe | <img src=x onerror=alert(1)> |");
  assert.ok(!html.includes("<img"), "table cells must not create live HTML elements");
  assert.ok(html.includes("&lt;img"), "escaped table-cell text should remain visible");
});

test("interactive Classroom sign-in always requests the account chooser", () => {
  assert.equal(INTERACTIVE_OAUTH_PROMPT, "select_account");
});
