// calendar-sync.js — corpus × what is already on the calendar → what to do.
//
// The whole sync decision, with no network in it. Every rule Pepuldo settled on
// 2026-09-09 is expressed here and nowhere else:
//
//   - pending work with a due date syncs, however far out;
//   - work with no due date does not sync — there is nowhere to put it;
//   - hidden courses do not sync (the caller filters them out, so their events
//     fall into the delete branch for free);
//   - work already handed in BEFORE the switch was turned on never appears;
//   - work handed in AFTER it stays, marked ✓, and unsubmitting reverses that;
//   - an event a student has edited by hand is never overwritten.

import { calendarEventBody, calendarEventId, eventFingerprint, isHandedIn, APP_MARKER } from "./calendar-event.js";

/** Is this one of ours? Reconcile must never touch an event we did not create. */
export function isOurEvent(event) {
  return event?.extendedProperties?.private?.app === APP_MARKER;
}

/**
 * Has a person edited this event since we last wrote it?
 *
 * We compare the event's CURRENT summary against the one our stored fingerprint
 * implies. If they disagree, somebody renamed it, and their edit is worth more
 * than our update — a moved or retitled study block is the most valuable data
 * in this system.
 */
export function isUserEdited(event, expectedSummary) {
  if (!isOurEvent(event)) return false;
  const stored = event.extendedProperties.private.fingerprint;
  // No stored fingerprint means the event predates this field; treat it as ours
  // rather than freezing it forever.
  if (!stored) return false;
  return typeof event.summary === "string" && event.summary !== expectedSummary;
}

/**
 * Turn a corpus and the calendar's current contents into a list of operations.
 *
 * `assignments` must already be filtered to the courses the student has not
 * hidden. Anything absent from it that we previously created gets deleted,
 * which is what makes un-hiding a course in Settings put its events back and
 * hiding one take them away, with no extra code.
 *
 * Returns `{ ops, counts }`; every op is `{ op, id, body?, event?, reason }` so
 * a caller can log exactly why each decision was made.
 */
/**
 * The date an event starts, as `YYYY-MM-DD`, for either shape of event.
 */
export function eventStartDate(event) {
  const start = event?.start || {};
  if (typeof start.date === "string") return start.date;
  if (typeof start.dateTime === "string") return start.dateTime.slice(0, 10);
  return "";
}

/**
 * Is this event old enough that its absence proves nothing?
 *
 * The planner deliberately stops returning coursework due more than a couple of
 * weeks ago (`shouldDropEarly`), so "not in the corpus" means two very different
 * things: deleted in Classroom, or simply aged out of the window we can see.
 * Deleting on the second reading would quietly erase the ✓ record of everything
 * finished more than a fortnight ago — the opposite of keeping it.
 *
 * So reconcile only removes events recent enough that we would still expect to
 * be shown their assignment. Anything older is history and is left alone.
 */
export function isBeyondReconcileHorizon(event, reconcileAfter) {
  const cutoff = String(reconcileAfter || "");
  if (!cutoff) return false;
  const start = eventStartDate(event);
  // An event with no readable date cannot be judged; leaving it is the safe
  // failure, since the alternative deletes somebody's record on a parse error.
  if (!start) return true;
  return start < cutoff;
}

export function calendarSyncPlan(assignments = [], existingEvents = [], options = {}) {
  const ops = [];
  const byId = new Map();
  for (const event of Array.isArray(existingEvents) ? existingEvents : []) {
    if (event?.id && isOurEvent(event)) byId.set(event.id, event);
  }
  const wanted = new Set();

  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    const id = calendarEventId(assignment?.courseId, assignment?.id);
    if (!id) continue;
    const body = calendarEventBody(assignment, options);
    if (!body) {
      // No due date. Not an error — most materials have none — but if we made
      // an event for it before (it HAD a date, and the teacher removed it),
      // that event is now unplaceable and should go.
      if (byId.has(id)) {
        wanted.add(id);
        ops.push({ op: "delete", id, event: byId.get(id), reason: "due date removed" });
      }
      continue;
    }
    wanted.add(id);
    const existing = byId.get(id);

    if (!existing) {
      // The rule that makes the calendar start the day you turn it on: work
      // already handed in before then is history, and history is not created.
      // Work handed in later already has an event, and takes the patch branch.
      if (isHandedIn(assignment.submission?.state)) {
        ops.push({ op: "skip", id, reason: "already handed in before first sync" });
        continue;
      }
      ops.push({ op: "create", id, body, reason: "new" });
      continue;
    }

    if (isUserEdited(existing, existingSummaryFor(existing, assignment))) {
      ops.push({ op: "skip", id, event: existing, reason: "edited by the student" });
      continue;
    }
    if (existing.extendedProperties.private.fingerprint === eventFingerprint(assignment)) {
      ops.push({ op: "skip", id, event: existing, reason: "unchanged" });
      continue;
    }
    ops.push({ op: "patch", id, body, event: existing, reason: "changed" });
  }

  // Anything of ours the corpus no longer contains: coursework deleted or
  // unpublished in Classroom, its course hidden in Settings, or the card
  // dismissed. Except when it is simply too old for us to still be shown it.
  for (const [id, event] of byId) {
    if (wanted.has(id)) continue;
    if (isBeyondReconcileHorizon(event, options.reconcileAfter)) {
      ops.push({ op: "skip", id, event, reason: "older than the reconcile horizon" });
      continue;
    }
    ops.push({ op: "delete", id, event, reason: "no longer in the corpus" });
  }

  const counts = { create: 0, patch: 0, delete: 0, skip: 0 };
  for (const op of ops) counts[op.op] += 1;
  return { ops, counts };
}

/**
 * What the summary would be if nobody had touched the event.
 *
 * Derived from the fingerprint we stored rather than from the assignment as it
 * is now — otherwise a title changed in Classroom would look like a student
 * edit and freeze the event permanently.
 */
function existingSummaryFor(event, assignment) {
  const stored = event?.extendedProperties?.private?.fingerprint || "";
  const parts = stored.split("|");
  if (parts.length < 4) return null;
  const [, title, , state] = parts;
  const prefix = state === "done" ? "✓ " : "";
  // A clamped title cannot be compared for equality, so fall back to a prefix
  // test rather than reporting a false edit on a very long assignment name.
  if (title.length >= 200) {
    return typeof event.summary === "string" && event.summary.startsWith(prefix + title)
      ? event.summary
      : null;
  }
  return prefix + title;
}

/**
 * Only the assignments that belong on a calendar at all.
 *
 * Dismissing a card is the student saying "stop showing me this", so it takes
 * the event with it, exactly as hiding its course does. Both are reversible:
 * un-dismissing or un-hiding puts the event back on the next sync.
 */
export function syncableAssignments(assignments = [], { hiddenCourseIds = new Set(), dismissedIds = new Set() } = {}) {
  const hidden = hiddenCourseIds instanceof Set ? hiddenCourseIds : new Set(hiddenCourseIds || []);
  const dismissed = dismissedIds instanceof Set ? dismissedIds : new Set(dismissedIds || []);
  return (Array.isArray(assignments) ? assignments : []).filter((a) =>
    a && a.kind === "assignment" && a.dueDate
    && !hidden.has(String(a.courseId))
    && !dismissed.has(a.id));
}
