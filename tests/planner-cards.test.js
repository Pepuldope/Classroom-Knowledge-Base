import test from "node:test";
import assert from "node:assert/strict";
import { dueChipModel, groupPlannerItems, sortPendingFirst, postedSinceYesterday } from "../planner-cards.js";

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

test("new-today assignments list not-done before submitted", () => {
  const pending = (a) => a.state === "todo";
  const items = [
    { kind: "assignment", id: "done1", state: "in" },
    { kind: "assignment", id: "todo1", state: "todo" },
    { kind: "assignment", id: "done2", state: "in" },
    { kind: "assignment", id: "todo2", state: "todo" },
  ];
  assert.deepEqual(sortPendingFirst(items, pending).map((i) => i.id),
    ["todo1", "todo2", "done1", "done2"]);
  // Within each half the caller's order survives — this is a stable partition.
  assert.deepEqual(sortPendingFirst(items.slice().reverse(), pending).map((i) => i.id),
    ["todo2", "todo1", "done2", "done1"]);
});

test("inside each half, the nearest deadline comes first", () => {
  const pending = (a) => a.id.startsWith("todo");
  const at = (iso) => new Date(iso).getTime();
  // Deliberately scrambled, and with a submitted item due before every
  // pending one — the halves must still not interleave.
  const items = [
    { kind: "assignment", id: "todo-friday", due: at("2026-09-18T23:59:00") },
    { kind: "assignment", id: "done-monday", due: at("2026-09-14T23:59:00") },
    { kind: "assignment", id: "todo-today", due: at("2026-09-11T23:59:00") },
    { kind: "assignment", id: "done-sunday", due: at("2026-09-13T23:59:00") },
  ];
  const sorted = sortPendingFirst(items, pending, { dueTime: (a) => a.due });
  assert.deepEqual(sorted.map((i) => i.id),
    ["todo-today", "todo-friday", "done-sunday", "done-monday"]);
});

test("work with no deadline sinks to the bottom of its own half", () => {
  const pending = () => true;
  const at = (iso) => new Date(iso).getTime();
  const items = [
    { kind: "assignment", id: "undated-first", due: null },
    { kind: "assignment", id: "friday", due: at("2026-09-18T23:59:00") },
    { kind: "assignment", id: "undated-second", due: undefined },
    { kind: "assignment", id: "today", due: at("2026-09-11T23:59:00") },
  ];
  const sorted = sortPendingFirst(items, pending, { dueTime: (a) => a.due });
  // Dated work in deadline order, then the undated in the order it arrived:
  // "no deadline" is not "due at the epoch", and it is not urgent either.
  assert.deepEqual(sorted.map((i) => i.id),
    ["today", "friday", "undated-first", "undated-second"]);
});

test("with no deadline accessor the caller's order still survives", () => {
  // The Planner's sort dropdown is the caller's order. When the student has
  // picked one explicitly, this must not quietly re-sort underneath them.
  const pending = (a) => a.id.startsWith("todo");
  const items = [
    { kind: "assignment", id: "todo-b", due: 2 },
    { kind: "assignment", id: "todo-a", due: 1 },
    { kind: "assignment", id: "done-b", due: 4 },
  ];
  assert.deepEqual(sortPendingFirst(items, pending).map((i) => i.id),
    ["todo-b", "todo-a", "done-b"]);
  assert.deepEqual(sortPendingFirst(items, pending, {}).map((i) => i.id),
    ["todo-b", "todo-a", "done-b"]);
});

test("only assignments are ranked by submission state", () => {
  const pending = () => false;
  // Materials have no submission; they must not be shuffled to the back.
  const items = [{ kind: "material", id: "m" }, { kind: "assignment", id: "a" }];
  assert.deepEqual(sortPendingFirst(items, pending).map((i) => i.id), ["m", "a"]);
  assert.deepEqual(sortPendingFirst([], pending), []);
  assert.deepEqual(sortPendingFirst(null, pending), []);
});


// --- "New since yesterday" ------------------------------------------------
// Reported 2026-09-10: the same item sat in this section for three days. The
// predicate below is not what was wrong — nothing ever re-ran it while the
// installed app stayed open. These pin the window it is supposed to have.

const AT = (iso) => new Date(iso);

test("the window starts at midnight at the beginning of yesterday", () => {
  const now = AT("2026-09-10T09:00:00");
  assert.equal(postedSinceYesterday("2026-09-10T08:00:00", now), true, "this morning");
  assert.equal(postedSinceYesterday("2026-09-09T00:00:00", now), true, "yesterday, on the stroke");
  assert.equal(postedSinceYesterday("2026-09-08T23:59:59", now), false, "a second before it");
});

test("nothing survives into a third day", () => {
  const posted = "2026-09-08T10:00:00";
  assert.equal(postedSinceYesterday(posted, AT("2026-09-08T18:00:00")), true, "day it was posted");
  assert.equal(postedSinceYesterday(posted, AT("2026-09-09T18:00:00")), true, "the day after");
  assert.equal(postedSinceYesterday(posted, AT("2026-09-10T00:00:01")), false, "the day after that");
});

test("a missing or unparseable timestamp is not new", () => {
  const now = AT("2026-09-10T09:00:00");
  assert.equal(postedSinceYesterday("", now), false);
  assert.equal(postedSinceYesterday(undefined, now), false);
  assert.equal(postedSinceYesterday("not a date", now), false);
});
