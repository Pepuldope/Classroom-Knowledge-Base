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
import { searchNotes, relatedNotes } from "../api/kb-retrieval.js";
import kbSearch from "../api/kb-search.js";
import kbNote from "../api/kb-note.js";
import kbRelated from "../api/kb-related.js";
import { saveBundle, getBundle } from "../api/kb-store.js";
import { highlightSnippet, tutorSourceList } from "../kb.js";

// Minimal Edge-like Request for the route handler (node 22 has global Request).
function makeReq(url, method = "GET") {
  return new Request("http://localhost" + url, { method });
}

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
