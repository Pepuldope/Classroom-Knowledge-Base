import test from "node:test";
import assert from "node:assert/strict";
import { dueChipModel, groupPlannerItems } from "../planner-cards.js";

test("submitted work is never overdue, however late", () => {
  // The reported bug: the card's styling checked isPending but the TEXT did
  // not, so handed-in work read "Overdue 5d · Submitted".
  assert.deepEqual(dueChipModel(-5, { pending: false }),
    { text: "Was due 5d ago", className: "", overdue: false });
  assert.deepEqual(dueChipModel(-5, { pending: true }),
    { text: "Overdue 5d", className: "overdue", overdue: true });
  // The red styling class only ever goes on genuinely overdue work.
  assert.equal(dueChipModel(-1, { pending: false }).className, "");
  assert.equal(dueChipModel(-90, { pending: false }).overdue, false);
});

test("the ordinary due labels are unchanged", () => {
  assert.equal(dueChipModel(0).text, "Due today");
  assert.equal(dueChipModel(1).text, "Due tomorrow");
  assert.equal(dueChipModel(4).text, "Due in 4d");
  assert.equal(dueChipModel(-1).text, "Overdue 1d");
  // Future dates read the same whether or not the work is in.
  assert.deepEqual(dueChipModel(3, { pending: false }), dueChipModel(3, { pending: true }));
  assert.equal(dueChipModel(NaN), null);
  assert.equal(dueChipModel(undefined), null);
});

test("assignments and materials are grouped, work first", () => {
  const items = [
    { kind: "material", id: "m1" },
    { kind: "assignment", id: "a1" },
    { kind: "material", id: "m2" },
    { kind: "assignment", id: "a2" },
  ];
  const { groups, showLabels } = groupPlannerItems(items);
  assert.deepEqual(groups.map((g) => g.label), ["Assignments", "Materials"]);
  assert.deepEqual(groups[0].items.map((i) => i.id), ["a1", "a2"]);
  assert.deepEqual(groups[1].items.map((i) => i.id), ["m1", "m2"]);
  assert.equal(showLabels, true);
  // Order within a group is the order it was given (the caller has sorted).
  assert.equal(groups[0].items[0].id, "a1");
});

test("a single-kind list gets no headings", () => {
  const only = groupPlannerItems([{ kind: "assignment" }, { kind: "assignment" }]);
  assert.deepEqual(only.groups.map((g) => g.label), ["Assignments"]);
  assert.equal(only.showLabels, false, "one heading over a uniform list is noise");
});

test("empty and unrecognised input still render somewhere", () => {
  assert.deepEqual(groupPlannerItems([]), { groups: [], showLabels: false });
  assert.deepEqual(groupPlannerItems(null), { groups: [], showLabels: false });
  const odd = groupPlannerItems([{ kind: "quiz" }, { kind: "assignment" }]);
  assert.deepEqual(odd.groups.map((g) => g.label), ["Assignments", "Other"]);
  assert.equal(odd.groups.find((g) => g.label === "Other").items.length, 1);
});
