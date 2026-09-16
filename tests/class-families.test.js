// The class category derived from a course name.
//
// Peter, 2026-09-16: "Increase accuracy of categories of classes." These were
// ten unanchored substring rules run first-match-wins against the raw course
// name. Every case in the first test is one they actually got wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveFamily, subjectTokens, CLASS_FAMILIES } from "../kb-client-search.js";

test("the cases the old rules got wrong", () => {
  // A TRACK is not a subject. archive-builder.js already strips "Digi" as a
  // track token; this function did not, so the track outranked the subject.
  assert.equal(deriveFamily("ELA Y2 Digi"), "Language", "the Digi track decided the subject");

  // "maturita" is the school-leaving exam, and there is one in every subject.
  // It was filed under Science/Math, so every maturita course landed there.
  assert.equal(deriveFamily("MATURITA SJL"), "Language");
  assert.equal(deriveFamily("MATURITA INFO Y4"), "Digital/IT");

  // Short needles matched inside longer words.
  assert.notEqual(deriveFamily("Transport and Logistics"), "PE", "tran-SPORT");
  assert.notEqual(deriveFamily("Kartografia"), "Arts", "k-ART-ografia");

  // And one it simply missed: PE, written the way a Slovak keyboard-less
  // export writes it.
  assert.equal(deriveFamily("Telesna vychova"), "PE");
});

test("ordinary courses still land where they did", () => {
  const cases = [
    ["Matematika Y3", "Science/Math"],
    ["Fyzika Y3", "Science/Math"],
    ["Chemia", "Science/Math"],
    ["Biologia", "Science/Math"],
    ["Informatika Y2", "Digital/IT"],
    ["Programming Lambda", "Digital/IT"],
    ["Anglicky jazyk Y1", "Language"],
    ["English Language Arts", "Language"],
    ["Dejepis Y3", "Humanities"],
    ["Obcianska nauka", "Humanities"],
    ["Business Strategy", "Business"],
    ["B.Eng Y1", "Engineering"],
    ["Vytvarna vychova", "Arts"],
    ["Hudobna vychova", "Arts"],
  ];
  for (const [course, family] of cases) {
    assert.equal(deriveFamily(course), family, `${course} should be ${family}`);
  }
});

test("a whole-token rule beats a substring rule", () => {
  // "MATURITA INFO Y4" must be decided by the token "info", not by whatever
  // substring happens to appear elsewhere in the name.
  assert.equal(deriveFamily("INFO maturitne opakovanie"), "Digital/IT");
});

test("accents and case make no difference", () => {
  assert.equal(deriveFamily("TELESNÁ VÝCHOVA"), "PE");
  assert.equal(deriveFamily("dejepis"), deriveFamily("DEJEPIS"));
  assert.equal(deriveFamily("Anglický jazyk"), "Language");
});

test("year and track tokens never reach the rules", () => {
  assert.deepEqual(subjectTokens("ELA Y2 Digi"), ["ela"]);
  assert.deepEqual(subjectTokens("Matematika Y4 Delta"), ["matematika"]);
  assert.deepEqual(subjectTokens("MATURITA INFO Y4"), ["info"]);
  assert.deepEqual(subjectTokens("Sem1 Trieda 3"), []);
});

test("an unrecognised course says so rather than guessing", () => {
  // Honest beats wrong: an empty family is a class the student can place by
  // hand, while a confidently wrong one is a category they have to notice.
  assert.equal(deriveFamily("NaE Y3 3.T"), "");
  assert.equal(deriveFamily(""), "");
  assert.equal(deriveFamily(null), "");
  assert.equal(deriveFamily("Y4"), "");
});

test("every family the rules can produce is offered to the override picker", () => {
  const produced = new Set();
  for (const course of [
    "Anglicky jazyk", "Matematika", "Dejepis", "Informatika", "B.Eng",
    "Ekonomika", "Buducnost", "Pedagogika", "Telesna vychova", "Vytvarna vychova",
  ]) {
    const f = deriveFamily(course);
    if (f) produced.add(f);
  }
  for (const f of produced) {
    assert.ok(CLASS_FAMILIES.includes(f), `${f} is derivable but not offered as a choice`);
  }
  assert.equal(new Set(CLASS_FAMILIES).size, CLASS_FAMILIES.length, "the picker lists a family twice");
});
