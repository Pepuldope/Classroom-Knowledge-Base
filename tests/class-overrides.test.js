// The student's own answer to "what kind of class is this".
//
// deriveFamily guesses from a course name, and a name is all it has. Peter,
// 2026-09-16: "make people able to rearrange them as they please so they can
// fix errors." These tests are about the rules of the board — what a move
// records, what it does NOT record, and what it takes to undo one.
import test from "node:test";
import assert from "node:assert/strict";
import {
  classFamilyOverridesModel,
  effectiveFamily,
  applyFamilyOverrides,
  classBoardModel,
  moveClassToFamily,
  UNCATEGORISED_LABEL,
} from "../class-overrides.js";

const bundle = {
  notes: [
    { course: "Kartografia", y: "2024-25", family: "" },
    { course: "Kartografia", y: "2025-26", family: "" },
    { course: "NaE Y3 3.T", y: "2023-24", family: "" },
    { course: "Matematika Y4", y: "2024-25", family: "Science/Math" },
  ],
  courses: [{ name: "NaE Y3 3.T", family: "" }],
};

test("a move records an override, and the card says it was yours", () => {
  const overrides = moveClassToFamily([], "NaE Y3 3.T", "Business");
  assert.deepEqual(overrides, [{ id: "NaE Y3 3.T", family: "Business" }]);
  const board = classBoardModel(bundle, overrides);
  const business = board.columns.find((c) => c.family === "Business");
  assert.deepEqual(business.classes.map((c) => c.name), ["NaE Y3 3.T"]);
  assert.equal(business.classes[0].overridden, true);
  assert.equal(board.overriddenCount, 1);
});

test("dropping a class where the rules already put it records nothing", () => {
  // Otherwise "put it back" would leave a stored preference behind that
  // silently stops tracking an improved rule.
  assert.deepEqual(moveClassToFamily([], "Matematika Y4", "Science/Math"), []);
  const board = classBoardModel(bundle, []);
  const maths = board.columns.find((c) => c.family === "Science/Math");
  assert.equal(maths.classes[0].overridden, false, "an agreeing drop was recorded as an override");
});

test("moving a class back to automatic removes the override", () => {
  const set = moveClassToFamily([], "NaE Y3 3.T", "Business");
  assert.deepEqual(moveClassToFamily(set, "NaE Y3 3.T", ""), []);
  assert.deepEqual(moveClassToFamily(set, "NaE Y3 3.T", "not a family"), []);
});

test("overrides are stamped onto every note of that course", () => {
  // Arts, not Humanities: the rules already say Humanities for this name, and a
  // drop the rules agree with is deliberately not recorded.
  const overrides = moveClassToFamily([], "Kartografia", "Arts");
  const out = applyFamilyOverrides(bundle, overrides);
  const karto = out.notes.filter((n) => n.course === "Kartografia");
  assert.equal(karto.length, 2);
  assert.ok(karto.every((n) => n.family === "Arts"));
  // Untouched courses keep the object they had, so nothing downstream churns.
  assert.equal(out.notes[3], bundle.notes[3]);
  assert.equal(out.courses[0].family, "");
});

test("applying nothing is a no-op, not a rewrite", () => {
  // The caller relies on this: it re-applies from a pristine base rather than
  // from the already-stamped bundle, because a projection cannot undo itself.
  assert.equal(applyFamilyOverrides(bundle, []), bundle);
  assert.equal(applyFamilyOverrides(null, [{ id: "x", family: "Arts" }]), null);
});

test("re-applying from the base is what undoes a move", () => {
  const set = moveClassToFamily([], "Kartografia", "Arts");
  const stamped = applyFamilyOverrides(bundle, set);
  assert.equal(stamped.notes[0].family, "Arts");
  // Undoing against the STAMPED bundle would silently keep Arts...
  assert.equal(applyFamilyOverrides(stamped, []).notes[0].family, "Arts");
  // ...which is why the base is kept.
  assert.equal(applyFamilyOverrides(bundle, []).notes[0].family, "");
});

test("the board keeps empty columns, and leads with the unsorted one", () => {
  const board = classBoardModel(bundle, []);
  assert.equal(board.columns[0].label, UNCATEGORISED_LABEL, "the column with work in it is not first");
  assert.deepEqual(board.columns[0].classes.map((c) => c.name), ["NaE Y3 3.T"]);
  assert.ok(board.columns.length > 3, "a board you can drag onto needs every column present");
  assert.ok(board.columns.some((c) => c.classes.length === 0), "empty columns were dropped");
  assert.equal(board.totalClasses, 3);
});

test("a class card carries what the student needs to judge it", () => {
  const board = classBoardModel(bundle, []);
  const karto = board.columns.flatMap((c) => c.classes).find((c) => c.name === "Kartografia");
  assert.equal(karto.noteCount, 2);
  assert.deepEqual(karto.years, ["2024-25", "2025-26"]);
});

test("stored overrides are normalized on the way in", () => {
  assert.deepEqual(classFamilyOverridesModel(null), []);
  assert.deepEqual(classFamilyOverridesModel([{ id: "", family: "Arts" }]), []);
  assert.deepEqual(classFamilyOverridesModel([{ id: "A", family: "Nonsense" }]), [],
    "a family the app no longer offers would render as a column that does not exist");
  assert.deepEqual(
    classFamilyOverridesModel([{ id: "A", family: "Arts" }, { id: "A", family: "PE" }]),
    [{ id: "A", family: "Arts" }],
    "one class, one category",
  );
});

test("effectiveFamily prefers the student over the rules", () => {
  assert.equal(effectiveFamily("Matematika Y4", []), "Science/Math");
  assert.equal(effectiveFamily("Matematika Y4", [{ id: "Matematika Y4", family: "Arts" }]), "Arts");
  assert.equal(effectiveFamily("NaE Y3 3.T", []), "");
});
