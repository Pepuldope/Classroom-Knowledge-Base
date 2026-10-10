import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMyTask, currentOccurrence, completeMyTask, myTaskPlannerItems, myTaskClassMaterials,
  upsertMyTask, removeMyTask, newMyTaskId, repeatLabel, repeatNeedsDate, parseDays, MY_TASK_PREFIX,
} from "../my-tasks.js";
import { mergeSyncedPrefs } from "../prefs-sync.js";

// 2026-10-10 is a Saturday; 2026-10-13 a Tuesday.
const SAT = "2026-10-10";
const weeklyTest = { id: "a1", title: "Vocab test", course: "English", courseId: "c1", repeat: "weekly", days: "2" };

test("a task needs a title, and a date only where its repeat asks for one", () => {
  assert.equal(normalizeMyTask({ id: "x", title: "  ", date: "2026-10-13" }), null);
  assert.equal(normalizeMyTask({ id: "x", title: "Test", date: "13.10.2026" }), null);
  assert.equal(normalizeMyTask({ id: "x", title: "Test", date: "2026-02-30" }), null);
  assert.equal(normalizeMyTask({ id: "x", title: "Test", repeat: "monthly" }), null);
  // Weekly needs weekdays, not a date.
  assert.equal(normalizeMyTask({ id: "x", title: "Test", repeat: "weekly" }), null);
  assert.deepEqual(normalizeMyTask({ id: "x", title: "Test", repeat: "weekly", days: "4,2", date: "2026-01-01" }),
    { id: "x", title: "Test", repeat: "weekly", days: "2,4" });
  assert.deepEqual(normalizeMyTask({ id: "x", title: "Gym", repeat: "daily" }), { id: "x", title: "Gym", repeat: "daily" });
  assert.equal(normalizeMyTask({ id: "x", title: "Test", date: "2026-10-13", repeat: "hourly" }).repeat, "none");
  assert.equal(repeatNeedsDate("weekly"), false);
  assert.equal(repeatNeedsDate("biweekly"), true);
  assert.deepEqual(parseDays("0,1,9,x,1"), [1, 0]);
});

test("a weekly task saved before weekdays existed keeps its weekday", () => {
  const legacy = { id: "l", title: "Old", date: "2026-10-13", repeat: "weekly" };
  assert.equal(normalizeMyTask(legacy).days, "2");
  assert.equal(currentOccurrence(legacy, SAT), "2026-10-13");
});

test("a one-off task stays due, even overdue, until it is ticked off", () => {
  const t = { id: "o", title: "Bring form", date: "2026-10-08", repeat: "none" };
  assert.equal(currentOccurrence(t, SAT), "2026-10-08");
  assert.equal(completeMyTask(t, SAT), null);
});

test("weekly: the next chosen weekday, rolling on by itself, never overdue", () => {
  assert.equal(currentOccurrence(weeklyTest, SAT), "2026-10-13");
  assert.equal(currentOccurrence(weeklyTest, "2026-10-13"), "2026-10-13");
  assert.equal(currentOccurrence(weeklyTest, "2026-10-14"), "2026-10-20");
  // Across the end of October (DST in Europe) the weekday holds.
  assert.equal(currentOccurrence(weeklyTest, "2026-10-28"), "2026-11-03");
  const twice = { ...weeklyTest, days: "2,4" };
  assert.equal(currentOccurrence(twice, "2026-10-14"), "2026-10-15");
});

test("ticking off skips to the next occurrence", () => {
  const done = completeMyTask(weeklyTest, SAT);
  assert.equal(done.doneThrough, "2026-10-13");
  assert.equal(currentOccurrence(done, SAT), "2026-10-20");
  const twice = completeMyTask({ ...weeklyTest, days: "2,4" }, SAT);
  assert.equal(currentOccurrence(twice, SAT), "2026-10-15");
  const daily = completeMyTask({ id: "d", title: "Read", repeat: "daily" }, SAT);
  assert.equal(currentOccurrence(daily, SAT), "2026-10-11");
});

test("every school day skips the weekend", () => {
  const t = { id: "w", title: "Duolingo", repeat: "weekdays" };
  assert.equal(currentOccurrence(t, SAT), "2026-10-12");
  assert.equal(currentOccurrence(completeMyTask(t, "2026-10-16"), "2026-10-16"), "2026-10-19");
});

test("every 2 weeks keeps its parity from the chosen date", () => {
  const t = { id: "b", title: "Lab", repeat: "biweekly", date: "2026-10-13" };
  assert.equal(currentOccurrence(t, SAT), "2026-10-13");
  assert.equal(currentOccurrence(t, "2026-10-14"), "2026-10-27");
  assert.equal(currentOccurrence(completeMyTask(t, SAT), SAT), "2026-10-27");
});

test("monthly lands on the same day, or the month's last day when it is short", () => {
  const t = { id: "m", title: "Rent", repeat: "monthly", date: "2026-10-31" };
  assert.equal(currentOccurrence(t, SAT), "2026-10-31");
  assert.equal(currentOccurrence(t, "2026-11-01"), "2026-11-30");
  assert.equal(currentOccurrence(t, "2027-02-01"), "2027-02-28");
});

test("the repeat reads as a short label", () => {
  assert.equal(repeatLabel(weeklyTest), "Every Tue");
  assert.equal(repeatLabel({ ...weeklyTest, days: "4,2" }), "Every Tue, Thu");
  assert.equal(repeatLabel({ id: "w", title: "x", repeat: "weekdays" }), "Every school day");
  assert.equal(repeatLabel({ id: "b", title: "x", repeat: "biweekly", date: "2026-10-13" }), "Every 2nd Tue");
  assert.equal(repeatLabel({ id: "m", title: "x", repeat: "monthly", date: "2026-10-31" }), "Monthly, day 31");
  assert.equal(repeatLabel({ id: "o", title: "x", date: "2026-10-31" }), "");
});

test("planner items look like assignments the lists already understand", () => {
  const [item] = myTaskPlannerItems([weeklyTest, { id: "bad" }], SAT);
  assert.equal(item.id, MY_TASK_PREFIX + "a1");
  assert.equal(item.kind, "assignment");
  assert.equal(item.custom, true);
  assert.equal(item.courseName, "English");
  assert.equal(item.courseId, "c1");
  assert.deepEqual(item.dueDate, { year: 2026, month: 10, day: 13 });
  assert.equal(item.submission, null);
  // No creationTime: it would land the task in "New since yesterday".
  assert.equal(item.creationTime, undefined);
});

test("class material: same class, recent or sharing a word — never another class", () => {
  const [item] = myTaskPlannerItems([{ ...weeklyTest, title: "Vocab test unit 4" }], SAT);
  const all = [
    { id: "m1", kind: "material", courseId: "c1", title: "Unit 4 word list", creationTime: "2026-08-01T08:00:00Z" },
    { id: "m2", kind: "material", courseId: "c1", title: "Reading handout", creationTime: "2026-10-08T08:00:00Z" },
    { id: "m3", kind: "material", courseId: "c1", title: "Old handout", creationTime: "2026-06-01T08:00:00Z" },
    { id: "m4", kind: "material", courseId: "c2", title: "Unit 4 maths", creationTime: "2026-10-09T08:00:00Z" },
    { id: "n1", kind: "announcement", courseId: "c1", title: "Unit 4 tomorrow", creationTime: "2026-10-09T08:00:00Z" },
  ];
  const titles = myTaskClassMaterials(item, all, SAT).map((m) => m.title);
  assert.deepEqual(titles.sort(), ["Reading handout", "Unit 4 word list"]);
  const [noClass] = myTaskPlannerItems([{ id: "z", title: "Unit 4", repeat: "daily" }], SAT);
  assert.deepEqual(myTaskClassMaterials(noClass, all, SAT), []);
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
  const a1 = merged.myTasks.a1;
  assert.deepEqual([a1.title, a1.repeat, a1.days, a1.doneThrough, a1.course, a1.courseId],
    ["Vocab test", "weekly", "2", "2026-10-13", "English", "c1"]);
  assert.equal(merged.myTasks.b2.date, "2026-10-15");
});
