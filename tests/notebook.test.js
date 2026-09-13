import test from "node:test";
import assert from "node:assert/strict";
import {
  noteKey, parseNoteKey, encodeSources, decodeSources, notebookAnswerModel, defaultAnswerTitle,
  answerCourse, renameAnswer, notebookModel, NOTEBOOK_SOURCES_MAX,
} from "../notebook.js";

const NOTES = [
  { t: "Všeobecný vzorec a diskriminant", course: "Y2 MAT", y: "2024-25", topic: "Kvadratické rovnice" },
  { t: "Animal Farm - Chapter 7", course: "ELA Year 2", y: "2024-25", topic: "Sprint 3" },
];
const K0 = noteKey(NOTES[0]);
const K1 = noteKey(NOTES[1]);

test("a note's key is the one pins have always used, and parses back", () => {
  assert.equal(K0, "Y2 MAT|2024-25|Všeobecný vzorec a diskriminant|Kvadratické rovnice");
  assert.deepEqual(parseNoteKey(K0), { course: "Y2 MAT", y: "2024-25", title: "Všeobecný vzorec a diskriminant", topic: "Kvadratické rovnice" });
  assert.deepEqual(parseNoteKey("junk"), { course: "", y: "", title: "", topic: "" });
});

test("sources round-trip as one string and stay inside the sync cap", () => {
  const encoded = encodeSources([{ k: K0, t: NOTES[0].t }, { k: K0, t: "dupe" }, { k: "", t: "no key" }]);
  assert.deepEqual(decodeSources(encoded), [{ k: K0, t: NOTES[0].t }]);
  const many = Array.from({ length: 80 }, (_, i) => ({ k: `C|2025-26|Note number ${i} with a longish title|T`, t: `Note number ${i} with a longish title` }));
  assert.ok(encodeSources(many).length <= NOTEBOOK_SOURCES_MAX);
  assert.deepEqual(decodeSources("{not json"), []);
  assert.equal(encodeSources([]), "");
});

test("an old saved answer (id, text, savedAt) still loads, with a title made for it", () => {
  const old = notebookAnswerModel({ id: "a1", text: "## Slope\nThe slope is rise over run.", savedAt: 5 });
  assert.equal(old.title, "Slope");
  assert.equal(old.course, "");
  assert.equal(notebookAnswerModel({ id: "", text: "x" }), null);
  assert.equal(defaultAnswerTitle({ question: "  What is   the slope?  " }), "What is the slope?");
  assert.equal(defaultAnswerTitle({}), "Saved answer");
});

test("an answer belongs to the open note's class, else to most of its sources", () => {
  assert.equal(answerCourse({ focusCourse: "MAT Y3", sources: [{ k: K1 }] }), "MAT Y3");
  assert.equal(answerCourse({ sources: [{ k: K0 }, { k: K1 }, { k: K0 }] }), "Y2 MAT");
  assert.equal(answerCourse({}), "");
});

test("renaming changes only that answer, and a blank name falls back instead of vanishing", () => {
  const list = [{ id: "a", text: "t", question: "What is D?" }, { id: "b", text: "u", title: "Keep" }];
  const renamed = renameAnswer(list, "a", "  Discriminant  ");
  assert.equal(renamed[0].title, "Discriminant");
  assert.equal(renamed[1].title, "Keep");
  assert.equal(renameAnswer(list, "a", "   ")[0].title, "What is D?");
});

test("the notebook groups answers and pins by class, links what still exists, and searches", () => {
  const answers = [
    { id: "a-old", text: "Older answer", savedAt: 1, course: "Y2 MAT", question: "D?", sources: encodeSources([{ k: K0, t: NOTES[0].t }, { k: "Gone|2020-21|Deleted note|", t: "Deleted note" }]) },
    { id: "a-new", text: "Newer answer about Napoleon", savedAt: 9, course: "ELA Year 2", title: "Napoleon" },
    { id: "a-none", text: "No class at all", savedAt: 3 },
  ];
  const pins = [{ id: K1, title: NOTES[1].t }, { id: K0, title: NOTES[0].t }];
  const nb = notebookModel({ answers, pins, notes: NOTES });
  assert.equal(nb.total, 5);
  assert.deepEqual(nb.groups.map((g) => g.course), ["ELA Year 2", "Y2 MAT", "Other"]);
  const mat = nb.groups[1].items;
  assert.deepEqual(mat.map((i) => i.kind), ["answer", "pin"], "answers first, then pins");
  assert.deepEqual(mat[0].sources.map((s) => s.noteIndex), [0, null], "a source no longer in the bundle is kept but not linked");
  assert.equal(mat[1].noteIndex, 0);

  const found = notebookModel({ answers, pins, notes: NOTES, query: "napoleon" });
  assert.equal(found.shown, 1);
  assert.equal(found.groups[0].items[0].id, "a-new");
  // Diacritics do not decide a search, and sources count as content.
  assert.equal(notebookModel({ answers, pins, notes: NOTES, query: "vseobecny" }).shown, 2);
  assert.equal(notebookModel({ answers, pins, notes: NOTES, query: "zzz" }).shown, 0);
});
