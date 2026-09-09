// calendar-event.js — a Classroom assignment, as a Google Calendar event.
//
// Pure and synchronous on purpose. Everything here is a decision that is easy
// to get wrong and impossible to notice from a screenshot — an off-by-one on an
// all-day end date, a deadline landing at 01:00 because a UTC instant was
// rebuilt as a local date — so none of it lives behind a network call.
//
// Design notes that are load-bearing (see docs/google-calendar-plan.md):
//   - event ids are DERIVED, not stored, so there is no mapping table to lose
//     and two devices converge on one event instead of duplicating it;
//   - the fingerprint is the literal text of the fields we own, not a hash, so
//     a collision cannot make us skip an update that was needed.

/** Google's id charset: base32hex, lowercase. RFC 4648 §7, lowercased. */
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";
/** Google requires 5–1024 characters for a client-supplied event id. */
export const MAX_EVENT_ID_LENGTH = 1024;

/** Encode bytes as lowercase base32hex, no padding (padding is not in the charset). */
function base32hex(bytes) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The event id for a piece of coursework. Same input, same id, forever.
 *
 * An ENCODING rather than a hash: Classroom ids are short, so there is no
 * reason to accept even a negligible chance of two assignments colliding onto
 * one calendar event. `ck` prefixes it because an id must start somewhere and
 * both characters are in the charset.
 *
 * Returns null when the input cannot produce a legal id, so a caller skips that
 * assignment instead of sending Google something it will reject.
 */
export function calendarEventId(courseId, courseWorkId) {
  const course = String(courseId ?? "").trim();
  const work = String(courseWorkId ?? "").trim();
  if (!course || !work) return null;
  // Length-prefixed, not `course:work`. A plain separator is ambiguous the
  // moment a Classroom id contains it: ("1", "2:3") and ("1:2", "3") both spell
  // "1:2:3" and would collide onto one event. Netstring framing cannot.
  const id = "ck" + base32hex(new TextEncoder().encode(`${course.length}:${course}${work}`));
  return id.length <= MAX_EVENT_ID_LENGTH ? id : null;
}

/** Two digits, because `2026-9-1` is not a date Google accepts. */
const pad = (n) => String(n).padStart(2, "0");

/** A Classroom {year, month, day} as `YYYY-MM-DD`, with no timezone applied. */
export function classroomDateString({ year, month, day } = {}) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * The day AFTER a date string.
 *
 * Google's all-day `end.date` is EXCLUSIVE: work due on Friday is
 * start 2026-09-11, end 2026-09-12. Get this wrong and every deadline either
 * shows a day early or spans two days, on every event, forever.
 */
export function nextDay(dateString) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ""));
  if (!parts) return null;
  const [, y, m, d] = parts;
  // UTC arithmetic so a machine in a negative offset does not roll the date
  // backwards on construction.
  const next = new Date(Date.UTC(+y, +m - 1, +d));
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/**
 * When the work is due, as an instant — or null if it is a date without a time.
 *
 * Classroom stores `dueDate`/`dueTime` in UTC. We emit the UTC instant and let
 * Google render it in the reader's own timezone, rather than reconstructing a
 * local wall-clock time ourselves. That is not laziness, it is the correct
 * answer: a 00:30 deadline for a student in UTC+2 is stored as 22:30 UTC on the
 * PREVIOUS day, and any code that rebuilds a local date from those fields puts
 * the event on the wrong day.
 */
export function dueInstant({ dueDate, dueTime } = {}) {
  const date = classroomDateString(dueDate);
  if (!date || !dueTime) return null;
  const { hours = 0, minutes = 0 } = dueTime;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return new Date(Date.UTC(dueDate.year, dueDate.month - 1, dueDate.day, hours, minutes)).toISOString();
}

/** How long before the deadline a timed block starts. */
export const DEFAULT_BLOCK_MINUTES = 30;

/** True for a submission state that means the student has handed the work in. */
export function isHandedIn(state) {
  return state === "TURNED_IN" || state === "RETURNED";
}

/**
 * The exact text of the fields we own, for change detection.
 *
 * Deliberately not a hash. A fingerprint collision would mean silently skipping
 * an update that was needed, and the strings involved are short enough that
 * there is no reason to accept that. Stored on the event in extended
 * properties, whose values cap at 1024 characters — hence the title clamp.
 */
export function eventFingerprint(assignment = {}) {
  const title = String(assignment.title || "").slice(0, 200);
  const instant = dueInstant(assignment) || classroomDateString(assignment.dueDate) || "";
  return `1|${title}|${instant}|${isHandedIn(assignment.submission?.state) ? "done" : "open"}`;
}

/** Prefix for work that has been handed in. */
export const DONE_PREFIX = "✓ ";

/**
 * The Google Calendar event resource for one assignment.
 *
 * Returns null when the assignment cannot be placed — no due date means there
 * is nowhere on a calendar to put it.
 */
export function calendarEventBody(assignment = {}, { blockMinutes = DEFAULT_BLOCK_MINUTES } = {}) {
  const id = calendarEventId(assignment.courseId, assignment.id);
  const dateOnly = classroomDateString(assignment.dueDate);
  if (!id || !dateOnly) return null;

  const done = isHandedIn(assignment.submission?.state);
  const instant = dueInstant(assignment);

  // A timed deadline gets a block ending at the deadline; a date with no time
  // gets an all-day event, because inventing a time would be a lie about when
  // the work is actually due.
  const when = instant
    ? {
      start: { dateTime: new Date(Date.parse(instant) - blockMinutes * 60000).toISOString() },
      end: { dateTime: instant },
    }
    : {
      start: { date: dateOnly },
      end: { date: nextDay(dateOnly) },
    };

  const description = [
    assignment.enrichment?.oneLineSummary,
    assignment.alternateLink ? `Open in Classroom: ${assignment.alternateLink}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    id,
    summary: (done ? DONE_PREFIX : "") + String(assignment.title || "Assignment"),
    ...when,
    ...(description ? { description } : {}),
    ...(assignment.alternateLink ? { source: { title: "Google Classroom", url: assignment.alternateLink } } : {}),
    // Handed-in work stops nagging but stays as a record.
    reminders: done
      ? { useDefault: false, overrides: [] }
      : { useDefault: false, overrides: [{ method: "popup", minutes: 24 * 60 }, { method: "popup", minutes: 120 }] },
    extendedProperties: {
      private: {
        app: APP_MARKER,
        courseId: String(assignment.courseId ?? ""),
        courseWorkId: String(assignment.id ?? ""),
        fingerprint: eventFingerprint(assignment),
      },
    },
  };
}

/** Marks an event as ours, so reconcile never touches anything we did not create. */
export const APP_MARKER = "classroom-kb";
