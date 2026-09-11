import test from "node:test";
import assert from "node:assert/strict";
import { tutorFocusModel, renderFocusBlock, buildTutorMessages, normalizeTutorNotes } from "../api/tutor.js";

const prompt = (notes, opts) => buildTutorMessages([{ role: "user", content: "q" }], notes, opts)[0].content;

// The reported transcript, 2026-09-11. The student had an ELA Y4 vocabulary
// quiz open and asked "what do i need to know for this quiz?". The tutor
// described the right note and then asked WHICH QUIZ THEY MEANT, listing five
// other vocabulary quizzes from other classes and other years.
const QUIZ = {
  title: "(GA) Vocabulary quiz",
  kind: "assignment",
  course: "ELA Y4 Omega",
  y: "2026-27",
  topic: "SPRINT 1",
  description: "Synonyms, similes and idioms. All materials are in the Classroom folders.",
  dueDate: "2026-09-15",
  dueInDays: 4,
  submitted: false,
  attachments: [{ title: "Vocabulary list.pdf", kind: "driveFile", text: "despondent, amiable, tepid" }],
};
const OTHER_NOTES = [
  { t: "(GA) Vocabulary Quiz", course: "BEng Y1", y: "2023-24", topic: "Sprint 1", s: "older quiz" },
  { t: "Environment - VOCABULARY QUIZ", course: "ELA Year 2", y: "2024-25", topic: "SPRINT 4", s: "different year" },
];

test("the open item is marked as the open item, not as note one", () => {
  const text = prompt(OTHER_NOTES, { focus: QUIZ });
  assert.match(text, /WHAT THE STUDENT IS LOOKING AT RIGHT NOW/);
  const anchorAt = text.indexOf("WHAT THE STUDENT IS LOOKING AT");
  const notesAt = text.indexOf("BACKGROUND: OTHER NOTES");
  assert.ok(anchorAt >= 0 && notesAt > anchorAt, "the anchor must come before the background notes");
  // The failure itself: the open item used to be rendered as "NOTE 1",
  // indistinguishable in form from five keyword matches.
  const anchorBlock = text.slice(anchorAt, notesAt);
  assert.match(anchorBlock, /\(GA\) Vocabulary quiz/);
  assert.ok(!/NOTE 1 — "\(GA\) Vocabulary quiz"/.test(text), "the open item is still being rendered as a plain note");
});

test("it is told not to ask which assignment the student means", () => {
  const text = prompt(OTHER_NOTES, { focus: QUIZ });
  assert.match(text, /Do NOT ask the student which assignment, class or quiz they mean/);
  // And with nothing open the opposite instruction applies — asking is correct.
  const noFocus = prompt(OTHER_NOTES, {});
  assert.match(noFocus, /Nothing is open right now/);
  assert.ok(!/Do NOT ask the student which assignment/.test(noFocus));
});

test("background notes are flagged as possibly from other classes and years", () => {
  const text = prompt(OTHER_NOTES, { focus: QUIZ });
  assert.match(text, /may be from OTHER classes or OTHER years/);
  // Without an anchor there is nothing to confuse them with, so no such warning.
  assert.ok(!/may be from OTHER classes/.test(prompt(OTHER_NOTES, {})));
});

test("the class and year of the open item are stated", () => {
  assert.match(prompt([], { focus: QUIZ }), /Class: ELA Y4 Omega, 2026-27/);
  const noCourse = prompt([], { focus: { ...QUIZ, course: "", y: "" } });
  assert.match(noCourse, /Class: not recorded/);
});

// --- attachments ----------------------------------------------------------

test("attachments are listed with their contents", () => {
  const text = prompt([], { focus: QUIZ });
  assert.match(text, /Attached materials \(1\)/);
  assert.match(text, /Vocabulary list\.pdf/);
  assert.match(text, /despondent, amiable, tepid/);
});

test("having no attachments is stated, because silence is not an answer", () => {
  const text = prompt([], { focus: { ...QUIZ, attachments: [] } });
  assert.match(text, /Attached materials: NONE/);
  assert.match(text, /say so plainly if asked/);
});

test("not knowing the attachments is different from there being none", () => {
  // The client that never sends the field must not cause a confident "none".
  const text = prompt([], { focus: { ...QUIZ, attachments: undefined } });
  assert.match(text, /Attached materials: not known/);
  assert.match(text, /do not claim there are none/);
  assert.ok(!/Attached materials: NONE/.test(text));
});

test("an unreadable attachment can be named but not quoted", () => {
  const text = prompt([], { focus: { ...QUIZ, attachments: [{ title: "slides.pptx", kind: "driveFile" }] } });
  assert.match(text, /slides\.pptx/);
  assert.match(text, /contents not readable/);
});

// --- time and status ------------------------------------------------------

test("the due date is stated in a form the student would use", () => {
  const at = (days) => prompt([], { focus: { ...QUIZ, dueInDays: days } });
  assert.match(at(0), /TODAY/);
  assert.match(at(1), /TOMORROW/);
  assert.match(at(4), /in 4 days/);
  assert.match(at(-2), /2 day\(s\) AGO/);
  assert.match(prompt([], { focus: { ...QUIZ, dueDate: "", dueInDays: null } }), /no due date set/);
});

test("submission state is carried, and 'unknown' is not 'not handed in'", () => {
  assert.match(prompt([], { focus: QUIZ }), /NOT handed in yet/);
  assert.match(prompt([], { focus: { ...QUIZ, submitted: true } }), /already handed in/);
  const unknown = prompt([], { focus: { ...QUIZ, submitted: null } });
  assert.ok(!/Status:/.test(unknown), "an unknown status must not be asserted either way");
});

test("today's date reaches the prompt", () => {
  assert.match(prompt([], { focus: QUIZ, today: "2026-09-11" }), /Today's date is 2026-09-11/);
});

// --- the grounding rules --------------------------------------------------

test("course facts are grounded but teaching a concept is allowed", () => {
  const text = prompt([], { focus: QUIZ });
  assert.match(text, /FACTS ABOUT THEIR COURSE[\s\S]*ONLY from the context/);
  assert.match(text, /EXPLAINING A CONCEPT is different/);
  assert.match(text, /Do not refuse to teach because the note is terse/);
  assert.match(text, /Never invent a due date, a grade, a task requirement or an attachment/);
});

// --- the shape of the request ---------------------------------------------

test("a malformed or absent focus is simply no focus", () => {
  assert.equal(tutorFocusModel(null), null);
  assert.equal(tutorFocusModel({}), null, "a focus with no title anchors nothing");
  assert.equal(tutorFocusModel("a string"), null);
  assert.equal(renderFocusBlock(null), "");
  // And the prompt still builds, without pretending something is open.
  assert.match(prompt(OTHER_NOTES, { focus: null }), /Nothing is open right now/);
});

test("focus fields are bounded before they reach the model", () => {
  const huge = tutorFocusModel({
    title: "t".repeat(5000),
    description: "d".repeat(9000),
    attachments: Array.from({ length: 50 }, (_, i) => ({ title: `a${i}`, text: "x".repeat(9000) })),
  });
  assert.equal(huge.title.length, 300);
  assert.equal(huge.description.length, 3000);
  assert.equal(huge.attachments.length, 8);
  assert.equal(huge.attachments[0].text.length, 2000);
});

test("the old positional language argument still works", () => {
  // kb_e2e_test and older callers pass "sk" as the third argument.
  const positional = buildTutorMessages([{ role: "user", content: "q" }], [], "sk")[0].content;
  assert.match(positional, /Reply in Slovak/);
  assert.match(prompt([], { language: "sk" }), /Reply in Slovak/);
  assert.ok(!/Reply in Slovak/.test(prompt([], { language: "en" })));
});

test("notes are still bounded and still carry their index", () => {
  const notes = normalizeTutorNotes([{ t: "x".repeat(999), s: "y".repeat(9999), noteIndex: 3 }]);
  assert.equal(notes[0].t.length, 300);
  assert.equal(notes[0].s.length, 1400);
  assert.equal(notes[0].noteIndex, 3);
});

// --- retrieval: the five-vocabulary-quizzes problem -----------------------

import { rankByCourseAffinity } from "../kb-tutor-context.js";

test("the student's own class outranks equally-good keyword matches", () => {
  // Every one of these matches "vocabulary quiz" about as well. Lexical search
  // alone returned them in an order that had nothing to do with the student.
  const hits = [
    { t: "(GA) Vocabulary Quiz", course: "BEng Y1", y: "2023-24", topic: "Sprint 1" },
    { t: "Environment - VOCABULARY QUIZ", course: "ELA Year 2", y: "2024-25", topic: "SPRINT 4" },
    { t: "(GA) Vocabulary quiz", course: "ELA Y4 Omega", y: "2026-27", topic: "SPRINT 1" },
    { t: "Sports - Vocabulary (3)", course: "ELA Year 2", y: "2024-25", topic: "SPRINT 3" },
  ];
  const ranked = rankByCourseAffinity(hits, { course: "ELA Y4 Omega", y: "2026-27", topic: "SPRINT 1" });
  assert.equal(ranked[0].course, "ELA Y4 Omega", "the open class did not come first");
});

test("the same class in an earlier year beats a different class", () => {
  const hits = [
    { t: "a", course: "BEng Y1", y: "2023-24" },
    { t: "b", course: "ELA Y4 Omega", y: "2024-25" },
  ];
  const ranked = rankByCourseAffinity(hits, { course: "ELA Y4 Omega", y: "2026-27" });
  assert.equal(ranked[0].t, "b");
});

test("other classes are demoted, never dropped", () => {
  // A topic taught in two subjects is a real case; filtering would break it.
  const hits = [
    { t: "a", course: "Physics", y: "2026-27" },
    { t: "b", course: "Math", y: "2026-27" },
  ];
  const ranked = rankByCourseAffinity(hits, { course: "Math", y: "2026-27" });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[1].t, "a");
});

test("with no focus the relevance order is left exactly as found", () => {
  const hits = [{ t: "a", course: "X" }, { t: "b", course: "Y" }];
  assert.deepEqual(rankByCourseAffinity(hits, null).map((h) => h.t), ["a", "b"]);
  assert.deepEqual(rankByCourseAffinity(hits, {}).map((h) => h.t), ["a", "b"]);
  // And ties keep their incoming order — relevance still decides within a rank.
  const same = [{ t: "a", course: "X" }, { t: "b", course: "X" }];
  assert.deepEqual(rankByCourseAffinity(same, { course: "X" }).map((h) => h.t), ["a", "b"]);
});

// --- per-question routing -------------------------------------------------

import { tutorQuestionTier } from "../api/tutor.js";
import { providerModels, providerModelEntries, PROVIDERS } from "../api/ai-router.js";

const ask = (q) => tutorQuestionTier([{ role: "user", content: q }]);

test("questions answered by reading the context back route cheap", () => {
  // Every one of these is a field we already put in the prompt. A 550B model
  // adds nothing to reading it out, and the key is shared and rate-limited.
  assert.equal(ask("when is this due?"), "quick");
  assert.equal(ask("have i submitted this yet"), "quick");
  assert.equal(ask("what's attached to this assignment?"), "quick");
  assert.equal(ask("what do i need to know for this quiz?"), "quick");
  assert.equal(ask("give me a summary"), "quick");
});

test("questions that need teaching or reasoning route strong", () => {
  assert.equal(ask("explain what an idiom is"), "hard");
  assert.equal(ask("why does this work?"), "hard");
  assert.equal(ask("how do i solve this equation"), "hard");
  assert.equal(ask("i don't understand similes"), "hard");
  assert.equal(ask("what's the difference between a simile and a metaphor"), "hard");
  assert.equal(ask("quiz me on these"), "hard");
});

test("a teaching request wearing a lookup's words is still teaching", () => {
  // Matches both pattern sets; reasoning has to win or the student gets the
  // small model for the question they most needed the big one for.
  assert.equal(ask("explain what i need to know for this quiz"), "hard");
  assert.equal(ask("summarise this and then explain why it matters"), "hard");
});

test("anything unclear gets the strong model, not the cheap one", () => {
  // The asymmetry: a wasted big call costs quota, a wrong small call costs the
  // student a worse explanation they cannot detect.
  assert.equal(ask("hmm"), "tutor");
  assert.equal(ask(""), "tutor");
  assert.equal(tutorQuestionTier([]), "tutor");
  assert.equal(tutorQuestionTier(null), "tutor");
  assert.equal(tutorQuestionTier([{ role: "assistant", content: "when is this due?" }]), "tutor");
  // A long question is doing more than asking for a field back.
  assert.equal(ask("a".repeat(200)), "hard");
});

test("the tier is read from the student's latest message, not the first", () => {
  const thread = [
    { role: "user", content: "when is this due?" },
    { role: "assistant", content: "Friday." },
    { role: "user", content: "explain why that matters" },
  ];
  assert.equal(tutorQuestionTier(thread), "hard");
});

// --- tier -> model selection ----------------------------------------------

const OPENROUTER = PROVIDERS.find((p) => p.name === "openrouter");

test("a cheap question puts a smaller model first, a hard one the strongest", () => {
  const strong = providerModels(OPENROUTER, { tier: 3 });
  const cheap = providerModels(OPENROUTER, { tier: 1 });
  const entries = providerModelEntries(OPENROUTER);
  const strengthOf = (id) => entries.find((e) => e.id === id).strength;
  assert.equal(strengthOf(strong[0]), 3, "a hard question did not get a strong model");
  assert.ok(strengthOf(cheap[0]) < 3, "a lookup still burned the strongest model");
});

test("no tier preference ever drops a model from the chain", () => {
  // The whole failover story rests on this: a preference reorders, it never
  // shortens. One provider carries production; a short chain is an outage.
  const full = providerModels(OPENROUTER).slice().sort();
  for (const tier of [1, 2, 3]) {
    assert.deepEqual(providerModels(OPENROUTER, { tier }).slice().sort(), full,
      `tier ${tier} lost a model from the chain`);
  }
});

test("ties break upward — the stronger model wins an equal gap", () => {
  const p = { models: [{ id: "weak", strength: 1 }, { id: "strong", strength: 3 }] };
  // Tier 2 is one step from both. The stronger one goes first.
  assert.deepEqual(providerModels(p, { tier: 2 }), ["strong", "weak"]);
});

test("a plain string chain still works and defaults to mid strength", () => {
  const p = { models: ["a", "b"] };
  assert.deepEqual(providerModels(p), ["a", "b"]);
  assert.deepEqual(providerModelEntries(p), [{ id: "a", strength: 2 }, { id: "b", strength: 2 }]);
  assert.deepEqual(providerModels({ model: "solo" }), ["solo"]);
});
