import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTutorRetrievedNotes, tutorRequestNotesModel, notePassages, verifyTutorQuotes, tutorSearchQuery } from "../kb-tutor-context.js";

test("buildTutorRetrievedNotes sends only the bounded notes selected by retrieval", () => {
  const bundle = {
    notes: [
      { t: "Algebra", x: "private algebra body", course: "Math" },
      { t: "History", x: "private history body", course: "History" },
      { t: "Biology", x: "private biology body", course: "Science" },
    ],
  };

  const selected = buildTutorRetrievedNotes(bundle, "algebra", { limit: 1 });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].t, "Algebra");
  assert.equal(selected[0].x, "private algebra body");
  assert.equal(selected.some((note) => note.t === "History"), false);
  assert.equal(selected.some((note) => note.t === "Biology"), false);
});

test("tutorRequestNotesModel keeps a many-match tutor payload under the browser budget", () => {
  const huge = "student note body ".repeat(5000);
  const bundle = {
    notes: Array.from({ length: 40 }, (_, index) => ({
      t: `Algebra lesson ${index}`,
      course: "Math",
      topic: "Quadratic equations",
      s: huge,
      x: huge,
    })),
  };

  const retrieved = buildTutorRetrievedNotes(bundle, "algebra quadratic", { limit: 40 });
  const notes = tutorRequestNotesModel(retrieved);
  const serialized = JSON.stringify({ messages: [{ role: "user", content: "Explain algebra" }], notes });

  assert.equal(notes.length, 8);
  assert.ok(serialized.length <= 24000, `payload was ${serialized.length} chars`);
  assert.ok(notes.every((note) => note.x.length <= 2200 && note.s.length <= 500));
  assert.ok(notes.every((note) => !Object.hasOwn(note, "p")));
});

// A long note's first 1,400 characters were usually its header and Drive links;
// the paragraph that answered the question was never sent.
const LONG_NOTE = [
  "Teacher materials:",
  ...Array.from({ length: 40 }, (_, i) => `- [Slides ${i}](https://docs.google.com/presentation/d/${"x".repeat(30)}${i})`),
  "",
  "Vrchol paraboly: pre funkciu y = ax² + bx + c leží vrchol v bode x = -b/2a.",
  "",
  ...Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i} about something else entirely, homework and deadlines.\n`),
  "Diskriminant D = b² - 4ac rozhoduje o počte koreňov kvadratickej rovnice.",
].join("\n");

test("a long note sends the passages that match the question, not its opening", () => {
  assert.ok(LONG_NOTE.length > 4000);
  assert.doesNotMatch(LONG_NOTE.slice(0, 2200), /Diskriminant/, "fixture: the answer must be past the old cut");
  const sent = notePassages(LONG_NOTE, "čo je diskriminant kvadratickej rovnice", 2200);
  assert.ok(sent.length <= 2200);
  assert.match(sent, /Diskriminant D = b² - 4ac/);
  assert.match(sent, /\[…\]/, "skipped text must be marked, or the model reads an excerpt as the whole note");
  // Both matching passages, in document order.
  const both = notePassages(LONG_NOTE, "vrchol paraboly diskriminant", 2200);
  assert.ok(both.indexOf("Vrchol") < both.indexOf("Diskriminant"));
});

test("passages fall back to the opening when nothing matches, and leave short notes whole", () => {
  assert.equal(notePassages(LONG_NOTE, "photosynthesis", 2200), LONG_NOTE.slice(0, 2200));
  assert.equal(notePassages(LONG_NOTE, "", 2200), LONG_NOTE.slice(0, 2200));
  assert.equal(notePassages("short body", "anything", 2200), "short body");
  const [sent] = tutorRequestNotesModel([{ t: "KF", x: LONG_NOTE }], { query: "diskriminant" });
  assert.match(sent.x, /Diskriminant/);
});

test("a quote is checked against the whole note it cites, not the excerpt", () => {
  const sources = [
    "Quadratics\nThe discriminant decides how many roots the equation has.",
    `Kvadratická funkcia\n${LONG_NOTE}`,
  ];
  const ok = verifyTutorQuotes('Your note says "the discriminant decides how many roots" [1], and “Diskriminant D = b² - 4ac rozhoduje” [2].', sources);
  assert.equal(ok.checked, 2);
  assert.deepEqual(ok.missing, []);

  // Paraphrase in quotation marks, and a real quote cited to the wrong note.
  const bad = verifyTutorQuotes('"the discriminant tells you the number of solutions" [1] and "vrchol v bode x = -b/2a" [1]', sources);
  assert.equal(bad.checked, 2);
  assert.deepEqual(bad.missing.map((q) => q.quote), ["the discriminant tells you the number of solutions", "vrchol v bode x = -b/2a"]);

  // Punctuation, case and diacritics do not decide it; a citation to a note
  // that was not sent cannot verify anything; uncited quotes are not checked.
  assert.equal(verifyTutorQuotes('"THE Discriminant, decides how many roots" [1]', sources).missing.length, 0);
  assert.equal(verifyTutorQuotes('"the discriminant decides how many roots" [7]', sources).missing.length, 1);
  assert.equal(verifyTutorQuotes('He said "the discriminant decides how many roots".', sources).checked, 0);
});

// Measured live 2026-09-13: "Čo je diskriminant a ako ho vypočítam? Odcituj
// moje poznámky." retrieved "MacBook Welcome" and "Lasica a Satinský: Soirée",
// matched on the words used to ask. On the vault, 3 of 12 conversational
// questions found their note in the top 6; with the asking words dropped, 10.
test("the words used to ask a question are not searched for", () => {
  assert.equal(tutorSearchQuery("Čo je diskriminant a ako ho vypočítam? Odcituj moje poznámky."), "diskriminant vypočítam");
  assert.equal(tutorSearchQuery("Can you explain what the STAR method is from my notes?"), "STAR method");
  assert.equal(tutorSearchQuery("Explain SQL joins to me please"), "SQL joins");
  // Nothing left to search for: keep the question rather than search for nothing.
  assert.equal(tutorSearchQuery("Explain this to me"), "Explain this to me");

  const bundle = {
    notes: [
      { t: "🍏 MacBook Welcome", x: "Ako si nastaviť MacBook. Moje poznámky a čo je dôležité." , course: "IntroWeek" },
      { t: "Všeobecný vzorec a diskriminant", x: "D = b² - 4ac", course: "Y2 MAT" },
      { t: "Lasica a Satinský", x: "Čo je humor a ako ho poznáme", course: "KUJ 2" },
    ],
  };
  const [top] = buildTutorRetrievedNotes(bundle, "Čo je diskriminant a ako ho vypočítam? Odcituj moje poznámky.", { limit: 1 });
  assert.equal(top.t, "Všeobecný vzorec a diskriminant");
});

test("the Planner tutor sends note content, not just the titles of its related notes", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const block = app.slice(app.indexOf("const tutorNotes"), app.indexOf("notes: tutorNotes"));
  assert.match(block, /tutorRequestNotesModel\(/);
  assert.match(block, /bundleNotes\[n\.noteIndex\]/, "relatedNotes results carry no body; they must be resolved to the full note");
});
