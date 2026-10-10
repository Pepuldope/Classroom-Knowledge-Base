import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMyTask, currentOccurrence, completeMyTask, myTaskPlannerItems,
  upsertMyTask, removeMyTask, newMyTaskId, MY_TASK_PREFIX,
} from "../my-tasks.js";
import { mergeSyncedPrefs } from "../prefs-sync.js";

// 2026-10-13 is a Tuesday.
const weeklyTest = { id: "a1", title: "Vocab test", course: "English", date: "2026-10-13", repeat: "weekly" };

test("a task needs a title and a real date", () => {
  assert.equal(normalizeMyTask({ id: "x", title: "  ", date: "2026-10-13" }), null);
  assert.equal(normalizeMyTask({ id: "x", title: "Test", date: "13.10.2026" }), null);
  assert.equal(normalizeMyTask({ id: "x", title: "Test", date: "2026-02-30x" }), null);
  assert.deepEqual(normalizeMyTask({ id: "x", title: " Test ", date: "2026-10-13", repeat: "daily" }),
    { id: "x", title: "Test", date: "2026-10-13", repeat: "none" });
});

test("a one-off task stays due, even overdue, until it is ticked off", () => {
  const t = { id: "o", title: "Bring form", date: "2026-10-08", repeat: "none" };
  assert.equal(currentOccurrence(t, "2026-10-10"), "2026-10-08");
  assert.equal(completeMyTask(t, "2026-10-10"), null);
});

test("a weekly task shows its first date until then", () => {
  assert.equal(currentOccurrence(weeklyTest, "2026-10-10"), "2026-10-13");
  assert.equal(currentOccurrence(weeklyTest, "2026-10-13"), "2026-10-13");
});

test("a weekly task rolls to next week once its day has passed, never overdue", () => {
  assert.equal(currentOccurrence(weeklyTest, "2026-10-14"), "2026-10-20");
  assert.equal(currentOccurrence(weeklyTest, "2026-10-20"), "2026-10-20");
  assert.equal(currentOccurrence(weeklyTest, "2026-12-01"), "2026-12-01");
  // Across the end of October (DST in Europe) the weekday holds.
  assert.equal(currentOccurrence(weeklyTest, "2026-10-28"), "2026-11-03");
});

test("ticking off a weekly task skips to the following week", () => {
  const done = completeMyTask(weeklyTest, "2026-10-12");
  assert.equal(done.doneThrough, "2026-10-13");
  assert.equal(currentOccurrence(done, "2026-10-12"), "2026-10-20");
  assert.equal(currentOccurrence(done, "2026-10-14"), "2026-10-20");
  const again = completeMyTask(done, "2026-10-14");
  assert.equal(currentOccurrence(again, "2026-10-14"), "2026-10-27");
});

test("planner items look like assignments the lists already understand", () => {
  const [item] = myTaskPlannerItems([weeklyTest, { id: "bad" }], "2026-10-10");
  assert.equal(item.id, MY_TASK_PREFIX + "a1");
  assert.equal(item.kind, "assignment");
  assert.equal(item.custom, true);
  assert.equal(item.courseName, "English");
  assert.deepEqual(item.dueDate, { year: 2026, month: 10, day: 13 });
  assert.equal(item.submission, null);
});

test("a finished one-off leaves the planner", () => {
  const t = { id: "o", title: "x", date: "2026-10-08", doneThrough: "2026-10-08" };
  assert.deepEqual(myTaskPlannerItems([t], "2026-10-10"), []);
});

test("upsert replaces by id, remove drops by id", () => {
  let list = upsertMyTask([], weeklyTest);
  list = upsertMyTask(list, { ...weeklyTest, title: "Grammar test" });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Grammar test");
  assert.deepEqual(removeMyTask(list, "a1"), []);
  assert.match(newMyTaskId(0, () => 0), /^t0/);
});

test("tasks survive the cross-device prefs merge with every field", () => {
  const at = Date.now();
  const merged = mergeSyncedPrefs(
    { myTasks: { a1: { at, ...weeklyTest, doneThrough: "2026-10-13" } } },
    { myTasks: { b2: { at, id: "b2", title: "Lab", date: "2026-10-15", repeat: "none" } } },
  );
  assert.equal(merged.myTasks.a1.title, "Vocab test");
  assert.equal(merged.myTasks.a1.repeat, "weekly");
  assert.equal(merged.myTasks.a1.date, "2026-10-13");
  assert.equal(merged.myTasks.a1.doneThrough, "2026-10-13");
  assert.equal(merged.myTasks.a1.course, "English");
  assert.equal(merged.myTasks.b2.title, "Lab");
});
