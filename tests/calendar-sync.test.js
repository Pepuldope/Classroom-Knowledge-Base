// Corpus × calendar → what to do. Every rule Pepuldo settled lives here.
import test from "node:test";
import assert from "node:assert/strict";
import { calendarSyncPlan, syncableAssignments, isOurEvent } from "../calendar-sync.js";
import { calendarEventBody, calendarEventId, APP_MARKER } from "../calendar-event.js";

const work = (id, over = {}) => ({
  id, courseId: "c1", kind: "assignment", title: `Task ${id}`,
  dueDate: { year: 2026, month: 9, day: 11 }, ...over,
});
/** What the calendar would hold after a successful sync of these assignments. */
const onCalendar = (assignments) => assignments.map((a) => calendarEventBody(a)).filter(Boolean);
const opFor = (plan, id) => plan.ops.find((o) => o.id === calendarEventId("c1", id));

test("new pending work is created", () => {
  const plan = calendarSyncPlan([work("w1")], []);
  assert.deepEqual(plan.counts, { create: 1, patch: 0, delete: 0, skip: 0 });
  assert.equal(plan.ops[0].body.summary, "Task w1");
});

test("an unchanged assignment is a no-op, so a daily sync costs nothing", () => {
  const a = work("w1");
  const plan = calendarSyncPlan([a], onCalendar([a]));
  assert.deepEqual(plan.counts, { create: 0, patch: 0, delete: 0, skip: 1 });
  assert.equal(plan.ops[0].reason, "unchanged");
});

test("a changed due date or title is patched", () => {
  const before = work("w1");
  const moved = work("w1", { dueDate: { year: 2026, month: 9, day: 18 } });
  const plan = calendarSyncPlan([moved], onCalendar([before]));
  assert.equal(plan.counts.patch, 1);
  assert.deepEqual(plan.ops[0].body.start, { date: "2026-09-18" });

  const renamed = calendarSyncPlan([work("w1", { title: "Renamed in Classroom" })], onCalendar([before]));
  assert.equal(renamed.counts.patch, 1, "a teacher renaming it in Classroom is not a student edit");
});

// --- the rule that makes the calendar start when you turn it on ------------

test("work handed in BEFORE the first sync never appears", () => {
  const done = work("w1", { submission: { state: "TURNED_IN" } });
  const plan = calendarSyncPlan([done], []);
  assert.deepEqual(plan.counts, { create: 0, patch: 0, delete: 0, skip: 1 });
  assert.equal(plan.ops[0].reason, "already handed in before first sync");
});

test("work handed in AFTER it appeared stays, marked done", () => {
  const pending = work("w1");
  const done = work("w1", { submission: { state: "TURNED_IN" } });
  const plan = calendarSyncPlan([done], onCalendar([pending]));
  assert.equal(plan.counts.patch, 1);
  assert.equal(plan.ops[0].body.summary, "✓ Task w1");
  assert.deepEqual(plan.ops[0].body.reminders.overrides, []);
});

test("unsubmitting brings the ✓ and the reminders back", () => {
  const done = work("w1", { submission: { state: "TURNED_IN" } });
  const back = work("w1", { submission: { state: "RECLAIMED_BY_STUDENT" } });
  const plan = calendarSyncPlan([back], onCalendar([done]));
  assert.equal(plan.counts.patch, 1);
  assert.equal(plan.ops[0].body.summary, "Task w1");
  assert.equal(plan.ops[0].body.reminders.overrides.length, 2);
});

// --- removals ---------------------------------------------------------------

test("coursework that left the corpus has its event deleted", () => {
  const gone = work("w1");
  const plan = calendarSyncPlan([], onCalendar([gone]));
  assert.deepEqual(plan.counts, { create: 0, patch: 0, delete: 1, skip: 0 });
  assert.equal(plan.ops[0].reason, "no longer in the corpus");
});

test("hiding a course removes its events, un-hiding puts them back", () => {
  // The caller filters hidden courses out, so this needs no code of its own —
  // which is the point. The Settings > Classes list becomes the calendar filter.
  const a = work("w1");
  const b = { ...work("w2"), courseId: "c2" };
  const calendar = onCalendar([a, b]);

  const hidden = syncableAssignments([a, b], { hiddenCourseIds: new Set(["c2"]) });
  assert.deepEqual(hidden.map((x) => x.id), ["w1"]);
  const off = calendarSyncPlan(hidden, calendar);
  assert.equal(off.counts.delete, 1);
  assert.equal(off.ops.find((o) => o.op === "delete").event.extendedProperties.private.courseId, "c2");

  const back = calendarSyncPlan(syncableAssignments([a, b]), calendar.filter((e) =>
    e.extendedProperties.private.courseId === "c1"));
  assert.equal(back.counts.create, 1, "un-hiding restores it");
});

test("a due date removed in Classroom removes the event", () => {
  const had = work("w1");
  const now = { ...work("w1"), dueDate: undefined };
  const plan = calendarSyncPlan([now], onCalendar([had]));
  assert.equal(plan.counts.delete, 1);
  assert.equal(plan.ops[0].reason, "due date removed");
});

// --- never clobber a person -------------------------------------------------

test("an event the student renamed is left completely alone", () => {
  const a = work("w1");
  const [event] = onCalendar([a]);
  const edited = { ...event, summary: "Pitch deck — DRAFT DONE, polish Thursday" };
  const changed = work("w1", { dueDate: { year: 2026, month: 9, day: 18 } });
  const plan = calendarSyncPlan([changed], [edited]);
  assert.deepEqual(plan.counts, { create: 0, patch: 0, delete: 0, skip: 1 });
  assert.equal(plan.ops[0].reason, "edited by the student");
});

test("events we did not create are invisible to the plan", () => {
  // Someone's own event, sitting on the same calendar. Reconcile must not
  // delete it, and it must not be mistaken for one of ours.
  const theirs = { id: "ckdeadbeef", summary: "Dentist" };
  assert.equal(isOurEvent(theirs), false);
  const plan = calendarSyncPlan([], [theirs]);
  assert.deepEqual(plan.counts, { create: 0, patch: 0, delete: 0, skip: 0 });
});

test("an event from before fingerprints existed is adopted, not frozen", () => {
  const [event] = onCalendar([work("w1")]);
  delete event.extendedProperties.private.fingerprint;
  const plan = calendarSyncPlan([work("w1", { title: "New title" })], [event]);
  assert.equal(plan.counts.patch, 1, "no fingerprint means unknown, not untouchable");
});

test("a very long title does not read as a student edit", () => {
  // The fingerprint clamps titles at 200 chars, so exact comparison would call
  // every long assignment "edited" and freeze it forever.
  const long = work("w1", { title: "L".repeat(400) });
  const plan = calendarSyncPlan([long], onCalendar([long]));
  assert.equal(plan.counts.skip, 1);
  assert.equal(plan.ops[0].reason, "unchanged");
});

// --- what is syncable at all -----------------------------------------------

test("only assignments with a due date are syncable", () => {
  const list = [
    work("w1"),
    { ...work("w2"), dueDate: undefined },
    { ...work("w3"), kind: "material" },
    null,
  ];
  assert.deepEqual(syncableAssignments(list).map((a) => a.id), ["w1"]);
  assert.deepEqual(syncableAssignments(), []);
  assert.deepEqual(syncableAssignments(null), []);
});

test("degenerate input plans nothing rather than throwing", () => {
  assert.deepEqual(calendarSyncPlan().counts, { create: 0, patch: 0, delete: 0, skip: 0 });
  assert.deepEqual(calendarSyncPlan(null, null).counts, { create: 0, patch: 0, delete: 0, skip: 0 });
  assert.deepEqual(calendarSyncPlan([{}], [null]).counts, { create: 0, patch: 0, delete: 0, skip: 0 });
});

test("a realistic mixed sync produces one op per assignment plus removals", () => {
  const pending = work("w1");
  const submitted = work("w2");
  const stale = work("w9");
  const calendar = onCalendar([pending, submitted, stale]);
  const plan = calendarSyncPlan(
    [pending, work("w2", { submission: { state: "TURNED_IN" } }), work("w3")],
    calendar,
  );
  assert.deepEqual(plan.counts, { create: 1, patch: 1, delete: 1, skip: 1 });
  assert.equal(opFor(plan, "w3").op, "create");
  assert.equal(opFor(plan, "w2").op, "patch");
  assert.equal(opFor(plan, "w9").op, "delete");
  assert.equal(opFor(plan, "w1").op, "skip");
});
