// One assignment, as a calendar event. The traps live here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarEventId, classroomDateString, nextDay, dueInstant, eventFingerprint,
  calendarEventBody, isHandedIn, MAX_EVENT_ID_LENGTH, DONE_PREFIX, APP_MARKER,
} from "../calendar-event.js";

test("event ids use only the charset Google accepts", () => {
  const id = calendarEventId("783942", "10298471");
  assert.match(id, /^[0-9a-v]+$/, "base32hex only: lowercase a-v and 0-9");
  assert.ok(id.length >= 5 && id.length <= MAX_EVENT_ID_LENGTH);
});

test("the same assignment always produces the same id", () => {
  // This is the whole reason there is no mapping table: two devices, or one
  // device after its storage is cleared, must converge on one event.
  assert.equal(calendarEventId("c1", "w1"), calendarEventId("c1", "w1"));
  assert.equal(calendarEventId(1, 1), calendarEventId("1", "1"), "numbers and strings agree");
});

test("different assignments never collide", () => {
  const ids = new Set();
  for (const course of ["1", "12", "c1"]) {
    for (const work of ["1", "12", "w1", "2:1"]) ids.add(calendarEventId(course, work));
  }
  assert.equal(ids.size, 12, "an encoding, not a hash — collisions are impossible by construction");
  // The separator must not let two different pairs meet in the middle.
  assert.notEqual(calendarEventId("1", "2:3"), calendarEventId("1:2", "3"));
});

test("an id that cannot be legal is refused rather than sent", () => {
  assert.equal(calendarEventId("", "w1"), null);
  assert.equal(calendarEventId("c1", ""), null);
  assert.equal(calendarEventId(null, undefined), null);
  assert.equal(calendarEventId("c".repeat(2000), "w1"), null, "over 1024 chars is rejected here, not by Google");
});

test("dates are zero-padded", () => {
  assert.equal(classroomDateString({ year: 2026, month: 9, day: 1 }), "2026-09-01");
  assert.equal(classroomDateString({ year: 2026, month: 12, day: 25 }), "2026-12-25");
  assert.equal(classroomDateString({}), null);
  assert.equal(classroomDateString(), null);
});

test("all-day end dates are exclusive", () => {
  // Google's end.date is the day AFTER. Every deadline is wrong if this is.
  assert.equal(nextDay("2026-09-11"), "2026-09-12");
  assert.equal(nextDay("2026-09-30"), "2026-10-01", "month boundary");
  assert.equal(nextDay("2026-12-31"), "2027-01-01", "year boundary");
  assert.equal(nextDay("2028-02-28"), "2028-02-29", "leap year");
  assert.equal(nextDay("2026-02-28"), "2026-03-01", "non-leap year");
  assert.equal(nextDay("nonsense"), null);
});

test("a due time becomes a UTC instant, not a rebuilt local date", () => {
  // The trap: a student in UTC+2 with a 00:30 deadline has it stored as 22:30
  // UTC on the PREVIOUS day. Emitting the instant lets Google render 00:30
  // locally; rebuilding a local date from these fields puts it a day out.
  assert.equal(
    dueInstant({ dueDate: { year: 2026, month: 9, day: 10 }, dueTime: { hours: 22, minutes: 30 } }),
    "2026-09-10T22:30:00.000Z",
  );
  assert.equal(
    dueInstant({ dueDate: { year: 2026, month: 9, day: 10 }, dueTime: { hours: 0, minutes: 0 } }),
    "2026-09-10T00:00:00.000Z",
    "midnight is a time, not a missing one",
  );
  assert.equal(dueInstant({ dueDate: { year: 2026, month: 9, day: 10 } }), null, "no time means all-day");
  assert.equal(dueInstant({}), null);
});

const ASSIGNMENT = {
  id: "w1", courseId: "c1", kind: "assignment",
  title: "Prepare the investor pitch deck",
  alternateLink: "https://classroom.google.com/c/x/a/y/details",
  dueDate: { year: 2026, month: 9, day: 11 },
  enrichment: { oneLineSummary: "Build and rehearse a ten-slide pitch." },
};

test("a date with no time is an all-day event spanning exactly one day", () => {
  const body = calendarEventBody(ASSIGNMENT);
  assert.deepEqual(body.start, { date: "2026-09-11" });
  assert.deepEqual(body.end, { date: "2026-09-12" });
  assert.equal(body.summary, "Prepare the investor pitch deck");
  assert.match(body.description, /Build and rehearse/);
  assert.match(body.description, /classroom\.google\.com/);
  assert.equal(body.source.url, ASSIGNMENT.alternateLink);
});

test("a timed deadline becomes a block ending at the deadline", () => {
  const body = calendarEventBody({ ...ASSIGNMENT, dueTime: { hours: 21, minutes: 0 } });
  assert.equal(body.end.dateTime, "2026-09-11T21:00:00.000Z", "the block ENDS when it is due");
  assert.equal(body.start.dateTime, "2026-09-11T20:30:00.000Z", "30 minutes by default");
  assert.equal(body.start.date, undefined, "not all-day");
  const longer = calendarEventBody({ ...ASSIGNMENT, dueTime: { hours: 21, minutes: 0 } }, { blockMinutes: 90 });
  assert.equal(longer.start.dateTime, "2026-09-11T19:30:00.000Z");
});

test("pending work carries reminders; handed-in work does not", () => {
  const pending = calendarEventBody(ASSIGNMENT);
  assert.deepEqual(pending.reminders.overrides.map((r) => r.minutes), [1440, 120]);

  const done = calendarEventBody({ ...ASSIGNMENT, submission: { state: "TURNED_IN" } });
  assert.equal(done.summary, DONE_PREFIX + ASSIGNMENT.title, "kept, marked done");
  assert.deepEqual(done.reminders.overrides, [], "a met deadline must stop nagging");
  assert.equal(done.reminders.useDefault, false, "or Google would apply its own");
});

test("unsubmitting reverses the done marking", () => {
  // Classroom calls the button Unsubmit; the API calls the state
  // RECLAIMED_BY_STUDENT. Handing work back in is not rare.
  const back = calendarEventBody({ ...ASSIGNMENT, submission: { state: "RECLAIMED_BY_STUDENT" } });
  assert.equal(back.summary, ASSIGNMENT.title, "the ✓ comes off");
  assert.equal(back.reminders.overrides.length, 2, "and the reminders come back");
  assert.equal(isHandedIn("RECLAIMED_BY_STUDENT"), false);
  assert.equal(isHandedIn("TURNED_IN"), true);
  assert.equal(isHandedIn("RETURNED"), true);
  assert.equal(isHandedIn("CREATED"), false);
  assert.equal(isHandedIn(undefined), false);
});

test("every event is marked as ours and carries its origin", () => {
  const props = calendarEventBody(ASSIGNMENT).extendedProperties.private;
  assert.equal(props.app, APP_MARKER, "reconcile must never touch a calendar entry we did not create");
  assert.equal(props.courseId, "c1");
  assert.equal(props.courseWorkId, "w1");
  assert.ok(props.fingerprint.length > 0);
});

test("work with no due date has nowhere to go", () => {
  assert.equal(calendarEventBody({ id: "w1", courseId: "c1", title: "Reading" }), null);
  assert.equal(calendarEventBody({}), null);
  assert.equal(calendarEventBody(), null);
});

test("the fingerprint changes exactly when something we own changes", () => {
  const base = eventFingerprint(ASSIGNMENT);
  assert.equal(eventFingerprint({ ...ASSIGNMENT }), base, "same input, same fingerprint");
  assert.notEqual(eventFingerprint({ ...ASSIGNMENT, title: "Renamed" }), base);
  assert.notEqual(eventFingerprint({ ...ASSIGNMENT, dueDate: { year: 2026, month: 9, day: 12 } }), base);
  assert.notEqual(eventFingerprint({ ...ASSIGNMENT, submission: { state: "TURNED_IN" } }), base);
  // Not ours: the tutor summary is not a field the calendar event's identity
  // depends on, so re-enrichment must not churn every event on the calendar.
  assert.equal(eventFingerprint({ ...ASSIGNMENT, enrichment: { oneLineSummary: "different" } }), base);
});

test("the fingerprint fits the 1024-char extended property limit", () => {
  const fp = eventFingerprint({ ...ASSIGNMENT, title: "x".repeat(5000) });
  assert.ok(fp.length < 1024, `fingerprint was ${fp.length} chars`);
});
