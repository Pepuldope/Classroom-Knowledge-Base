import test from "node:test";
import assert from "node:assert/strict";
import { relatedCourseMaterials, scoreRelatedMaterial, titleTokens } from "../related-materials.js";

// The real case, from the tutor's own words: "The assignment says the materials
// are in your Classroom folders, but there are no attachments listed on this
// assignment." They were in the class, as separate posts.
const QUIZ = {
  id: "cw1", kind: "assignment", title: "(GA) Vocabulary quiz",
  courseId: "c-ela4", courseName: "ELA Y4 Omega", creationTime: "2026-09-08T09:00:00Z",
};
const CLASS_POSTS = [
  { id: "m1", kind: "material", title: "Vocabulary — synonyms, similes, idioms", courseId: "c-ela4", creationTime: "2026-09-07T10:00:00Z", alternateLink: "https://classroom.google.com/m1" },
  { id: "m2", kind: "material", title: "Stereometry formulae", courseId: "c-ela4", creationTime: "2026-02-01T10:00:00Z" },
  { id: "m3", kind: "material", title: "Vocabulary list Sprint 1", courseId: "c-other", creationTime: "2026-09-08T10:00:00Z" },
  { id: "a2", kind: "announcement", title: "Reminder: quiz on Friday", courseId: "c-ela4", creationTime: "2026-09-08T11:00:00Z" },
  { id: "m4", kind: "material", title: "Lesson slides week 2", courseId: "c-ela4", creationTime: "2026-09-08T08:00:00Z" },
];

test("the handout posted next to the quiz is found", () => {
  const found = relatedCourseMaterials(QUIZ, CLASS_POSTS);
  assert.equal(found[0].title, "Vocabulary — synonyms, similes, idioms");
  assert.match(found[0].why, /similar title/);
  assert.equal(found[0].link, "https://classroom.google.com/m1");
  assert.equal(found[0].postedAt, "2026-09-07");
});

test("another class is a wrong answer, not a weaker match", () => {
  // m3 has the better title overlap AND a closer date. It is still wrong.
  const found = relatedCourseMaterials(QUIZ, CLASS_POSTS);
  assert.ok(!found.some((f) => f.title.includes("Sprint 1")), "a different course leaked in");
});

test("the item never suggests itself", () => {
  assert.ok(!relatedCourseMaterials(QUIZ, [QUIZ, ...CLASS_POSTS]).some((f) => f.title === QUIZ.title));
  assert.equal(scoreRelatedMaterial(QUIZ, QUIZ), null);
});

test("announcements are chatter, not material to study from", () => {
  assert.equal(scoreRelatedMaterial(QUIZ, CLASS_POSTS[3]), null);
});

test("something posted months earlier with nothing in common is not a match", () => {
  assert.equal(scoreRelatedMaterial(QUIZ, CLASS_POSTS[1]), null, "the whole term was listed");
});

test("posted the same day counts even with no shared words", () => {
  // "Lesson slides week 2" shares no distinctive token with the quiz, but a
  // teacher posting both within hours is a real signal on its own.
  const slides = scoreRelatedMaterial(QUIZ, CLASS_POSTS[4]);
  assert.ok(slides, "same-day class material was discarded");
  assert.match(slides.why, /posted/);
});

test("Classroom's boilerplate words cannot fake a match", () => {
  // This is the failure this area keeps returning to: "quiz", "assignment",
  // "material" appear on every third post and identify nothing.
  const tokens = titleTokens("(GA) Vocabulary quiz assignment material");
  assert.deepEqual([...tokens], ["vocabulary"]);
  // Two posts sharing only boilerplate, months apart, must not match.
  const far = { id: "x", kind: "material", title: "Homework task worksheet", courseId: "c-ela4", creationTime: "2026-01-01T00:00:00Z" };
  assert.equal(scoreRelatedMaterial(QUIZ, far), null);
});

test("a material outranks an assignment of equal similarity", () => {
  // "The materials are in the Classroom folders" means a material.
  const base = { courseId: "c-ela4", creationTime: "2026-09-08T09:00:00Z", title: "Vocabulary revision" };
  const found = relatedCourseMaterials(QUIZ, [
    { ...base, id: "as", kind: "assignment" },
    { ...base, id: "ma", kind: "material" },
  ]);
  assert.equal(found[0].kind, "material");
});

test("courses are matched by name when there is no id", () => {
  const item = { id: "i", title: "Vocabulary quiz", courseName: "ELA Y4", creationTime: "2026-09-08T09:00:00Z" };
  const hit = { id: "h", kind: "material", title: "Vocabulary handout", courseName: "ELA Y4", creationTime: "2026-09-08T09:00:00Z" };
  const miss = { id: "j", kind: "material", title: "Vocabulary handout", courseName: "BEng Y1", creationTime: "2026-09-08T09:00:00Z" };
  assert.equal(relatedCourseMaterials(item, [hit, miss]).length, 1);
});

test("missing dates and junk input do not throw or match wildly", () => {
  const undated = { id: "u", kind: "material", title: "Vocabulary handout", courseId: "c-ela4" };
  // No date: the title alone still carries it.
  assert.ok(scoreRelatedMaterial(QUIZ, undated));
  assert.equal(scoreRelatedMaterial(QUIZ, { id: "z", kind: "material", courseId: "c-ela4" }), null);
  assert.equal(scoreRelatedMaterial(null, undated), null);
  assert.equal(scoreRelatedMaterial(QUIZ, null), null);
  assert.deepEqual(relatedCourseMaterials(QUIZ, null), []);
  assert.deepEqual(relatedCourseMaterials(QUIZ, [], { limit: 0 }), []);
});

test("the list is capped", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`, kind: "material", title: `Vocabulary handout ${i}`,
    courseId: "c-ela4", creationTime: "2026-09-08T09:00:00Z",
  }));
  assert.equal(relatedCourseMaterials(QUIZ, many).length, 5);
  assert.equal(relatedCourseMaterials(QUIZ, many, { limit: 2 }).length, 2);
});
