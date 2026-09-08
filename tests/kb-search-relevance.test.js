// Search relevance, measured rather than asserted by feel.
//
// The corpus is shaped like the owner's: Slovak and English course names,
// sprint topics, long bodies, and a great deal of near-identical boilerplate —
// which is what makes ranking hard. Each query names the note a reader would
// mean by it.
//
// Baseline before this suite existed: 25/33 first-place hits, MRR 0.818.
import test from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../kb-client-search.js";

// A corpus shaped like the owner's: Slovak/English course names, sprint topics,
// long bodies, and a lot of near-duplicate boilerplate — which is exactly what
// makes ranking hard.
function corpus() {
  const notes = [];
  const add = (course, y, topic, t, s, x) => notes.push({ p: `${y}/vault/${course}/${topic}/${t}`, t, course, y, topic, kind: "note", s, x });
  const boiler = "Submit your work through Google Classroom before the deadline. Ask the teacher if anything is unclear. This assignment is part of the sprint and counts towards your final grade. ";

  add("NaE Y3 3.T", "2025-26", "Sprint 1", "Pitch deck for the investor day", "Build and deliver a pitch deck", boiler + "Prepare a pitch deck covering the problem, the solution, the market size and your business model. Practise delivery. " + boiler);
  add("NaE Y3 3.T", "2025-26", "Sprint 2", "Market research report", "Research your target market", boiler + "Interview at least ten potential customers about the problem. Summarise the market research findings in a report. " + boiler);
  add("NaE Y3 3.T", "2025-26", "Sprint 3", "Business model canvas", "Fill in the canvas", boiler + "Complete every block of the business model canvas including revenue streams and cost structure. " + boiler);
  add("Matematika Y3", "2025-26", "Algebra", "Quadratic equations practice", "Solve quadratics", boiler + "Solve the quadratic equations by factoring and with the quadratic formula. Sketch each parabola. " + boiler);
  add("Matematika Y3", "2025-26", "Algebra", "Logarithms worksheet", "Laws of logarithms", boiler + "Apply the laws of logarithms to simplify expressions and solve logarithmic equations. " + boiler);
  add("Matematika Y3", "2025-26", "Stereometry", "Volume of solids", "Volumes and surface areas", boiler + "Compute the volume and surface area of prisms, pyramids, cylinders and cones. " + boiler);
  add("ELA Y3", "2025-26", "Applications", "Cover letter workshop", "Write a cover letter", boiler + "Write a cover letter for a real job advert. Open by naming the role, give two pieces of evidence, close with a call to action. " + boiler);
  add("ELA Y3", "2025-26", "Applications", "CV and resume review", "Build your CV", boiler + "Draft a one page CV. Peer review a classmate's CV against the checklist. " + boiler);
  add("ELA Y3", "2025-26", "Interview", "STAR method practice", "Answer using STAR", boiler + "Answer behavioural interview questions using the STAR method: situation, task, action, result. " + boiler);
  add("Budúcnosť po Lýceu", "2025-26", "Careers", "Mock interview day", "Practise interviews", boiler + "Take part in a mock interview with an external assessor. Bring your CV and a cover letter. " + boiler);
  add("Databázy Y3", "2025-26", "SQL", "SQL joins exercise", "Practise joins", boiler + "Write SQL queries using inner join, left join and right join across three tables. " + boiler);
  add("Databázy Y3", "2025-26", "SQL", "Normalisation to third normal form", "Normalise the schema", boiler + "Normalise the given schema to third normal form and explain each step. " + boiler);
  add("GLO Y3", "2025-26", "History", "Cold War timeline", "Build a timeline", boiler + "Produce an annotated timeline of the Cold War from 1945 to 1991. " + boiler);
  add("Science Y3", "2025-26", "Optics", "Refraction lab report", "Write up the refraction lab", boiler + "Measure the angle of refraction through a glass block and calculate the refractive index. " + boiler);
  add("BEng Y1", "2023-24", "Intro", "Engineering design brief", "First design brief", boiler + "Produce a design brief for a simple mechanism. Include sketches and a bill of materials. " + boiler);
  // Boilerplate-only decoys: they match common words and nothing meaningful.
  for (let i = 0; i < 12; i++) {
    add("NaE 1 T", "2023-24", `Sprint ${1 + (i % 4)}`, `Weekly reflection ${i + 1}`, "Reflect on the sprint", boiler + boiler + "Write a short reflection about the sprint and the assignment you submitted. " + boiler);
  }
  // Decoys built to expose specific ranking failures.
  // 1. A note whose TITLE is made of the commonest words in the corpus. Without
  //    IDF it outranks a specific match for any query containing one of them.
  add("NaE 1 T", "2023-24", "Admin", "Assignment submission and sprint deadline guide",
      "How to submit an assignment for the sprint", boiler + boiler + "Every assignment in every sprint must be submitted through Google Classroom. " + boiler);
  // 2. "cover" and "letter" present but unrelated and far apart — a phrase
  //    query should prefer the note that actually means it.
  add("GLO Y3", "2025-26", "History", "Reading the primary sources",
      "Sources and evidence", boiler + "The cover of the book is not evidence. Study every letter of the treaty text closely. " + boiler);
  // 3. A stem-collision: "normalisation" and "normal" share six characters, so
  //    fuzzy matching treats a query for one as a hit on the other.
  add("Science Y3", "2025-26", "Statistics", "The normal distribution",
      "Normal distribution basics", boiler + "Sketch the normal distribution and mark one and two standard deviations. " + boiler);
  return notes;
}

// query -> the title that should come first.
const QUERIES = [
  ["cover letter", "Cover letter workshop"],
  ["quadratic equations", "Quadratic equations practice"],
  ["star method interview", "STAR method practice"],
  ["sql joins", "SQL joins exercise"],
  ["pitch deck", "Pitch deck for the investor day"],
  ["market research", "Market research report"],
  ["logarithms", "Logarithms worksheet"],
  ["business model canvas", "Business model canvas"],
  ["third normal form", "Normalisation to third normal form"],
  ["cold war timeline", "Cold War timeline"],
  ["refraction lab", "Refraction lab report"],
  ["volume of solids", "Volume of solids"],
  ["mock interview", "Mock interview day"],
  ["cv review", "CV and resume review"],
  ["design brief", "Engineering design brief"],
  // Harder: the discriminating word is rare but the rest is boilerplate.
  ["sprint reflection", "Weekly reflection 1"],
  ["parabola", "Quadratic equations practice"],
  ["revenue streams", "Business model canvas"],

  // --- the hard ones ------------------------------------------------------
  // A rare word next to the commonest words in the corpus. The specific note
  // must win over the note whose title is made of boilerplate.
  ["assignment quadratic", "Quadratic equations practice"],
  ["sprint pitch deck", "Pitch deck for the investor day"],
  ["submit cover letter", "Cover letter workshop"],
  // The words are adjacent in one note and scattered in another.
  ["cover letter", "Cover letter workshop"],
  // Stem collision: "normal form" must not be beaten by "normal distribution".
  ["third normal form", "Normalisation to third normal form"],
  // Only one query token is discriminating; the rest is filler.
  ["classroom deadline logarithms", "Logarithms worksheet"],
  ["sprint assignment star method", "STAR method practice"],

  // A remembered phrase plus a word that is in literally every note. These are
  // the cases the flat field weights get wrong: the note whose TITLE is made of
  // common words wins on the common word alone.
  ["parabola sprint", "Quadratic equations practice"],
  ["bill of materials sprint", "Engineering design brief"],
  ["ten customers sprint assignment", "Market research report"],
  ["standard deviations assignment sprint", "The normal distribution"],
  ["annotated timeline assignment sprint", "Cold War timeline"],
  ["inner join assignment sprint", "SQL joins exercise"],
  ["call to action assignment sprint", "Cover letter workshop"],
  // An exact match must beat a stem collision: "normal" is exactly the title of
  // one note and a prefix of another.
  ["normal", "The normal distribution"],
];

const NOTES = corpus();
const top = (q, n = 1) => searchNotes(NOTES, q, { limit: 10 }).slice(0, n).map((h) => h.t);

test("every benchmark query puts the right note first", () => {
  const misses = [];
  let reciprocal = 0;
  for (const [query, want] of QUERIES) {
    const hits = searchNotes(NOTES, query, { limit: 10 });
    const rank = hits.findIndex((h) => h.t === want) + 1;
    if (rank > 0) reciprocal += 1 / rank;
    if (rank !== 1) misses.push(`${query} -> wanted "${want}", got ${rank === 0 ? "nothing in the top 10" : `rank ${rank} ("${hits[0]?.t}")`}`);
  }
  assert.deepEqual(misses, [], `${misses.length} of ${QUERIES.length} queries regressed:\n  ${misses.join("\n  ")}`);
  assert.equal(reciprocal / QUERIES.length, 1, "mean reciprocal rank should be 1");
});

// --- the specific defects, named ------------------------------------------

test("a rare word beats a common one in a heavier field", () => {
  // "parabola" appears in one note's body; "sprint" is in most titles. Flat
  // field weights returned the boilerplate note and buried the real one.
  assert.deepEqual(top("parabola sprint"), ["Quadratic equations practice"]);
  assert.deepEqual(top("bill of materials sprint"), ["Engineering design brief"]);
  assert.deepEqual(top("call to action assignment sprint"), ["Cover letter workshop"]);
});

test("answering the whole query outranks answering part of it loudly", () => {
  // The note whose title is made of the corpus's commonest words matched one
  // token in four fields and won on volume.
  const hits = searchNotes(NOTES, "inner join assignment sprint", { limit: 3 });
  assert.equal(hits[0].t, "SQL joins exercise");
  assert.notEqual(hits[0].t, "Assignment submission and sprint deadline guide");
});

test("an exact word beats a stem collision", () => {
  // "normal" is the whole word in one title and the first six letters of
  // "normalisation" in another, which used to collect the score twice.
  assert.deepEqual(top("normal"), ["The normal distribution"]);
  // ...without breaking the note that genuinely is about normalisation.
  assert.deepEqual(top("normalise schema"), ["Normalisation to third normal form"]);
  assert.deepEqual(top("third normal form"), ["Normalisation to third normal form"]);
});

test("an exact phrase is preferred over the same words scattered", () => {
  // One note is a cover-letter task; another says "the cover of the book" and
  // "every letter of the treaty".
  assert.deepEqual(top("cover letter"), ["Cover letter workshop"]);
});

test("ordinary single-word queries still behave", () => {
  assert.deepEqual(top("logarithm"), ["Logarithms worksheet"]);
  assert.deepEqual(top("sql"), ["SQL joins exercise"]);
  assert.deepEqual(top("cv"), ["CV and resume review"]);
  assert.equal(searchNotes(NOTES, "zzzznothing", { limit: 5 }).length, 0);
  assert.equal(searchNotes(NOTES, "", { limit: 5 }).length, 0);
});
