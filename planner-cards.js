// planner-cards.js — pure display models for the Planner's assignment cards.
//
// Kept out of app.js so they can be tested without a browser, matching the
// other pure-model modules next door (enrich-scope.js, study-progress.js).

/**
 * The due chip on a card.
 *
 * `pending` is the whole point: work that has been handed in is not overdue,
 * however far past its due date it is. The card's *styling* already checked
 * this (`days < 0 && isPending(a)` picked the red class) but the *text* did
 * not, so a submitted assignment read "Overdue 5d · Submitted" — telling the
 * student off for something they had already done.
 */
export function dueChipModel(days, { pending = true } = {}) {
  if (!Number.isFinite(days)) return null;
  const d = Math.trunc(days);
  if (d < 0) {
    return pending
      ? { text: `Overdue ${-d}d`, className: "overdue", overdue: true }
      // Neutral and factual. The "Submitted" chip beside it carries the status.
      : { text: `Was due ${-d}d ago`, className: "", overdue: false };
  }
  if (d === 0) return { text: "Due today", className: "", overdue: false };
  if (d === 1) return { text: "Due tomorrow", className: "", overdue: false };
  return { text: `Due in ${d}d`, className: "", overdue: false };
}

const GROUP_ORDER = [
  { key: "assignment", label: "Assignments" },
  { key: "material", label: "Materials" },
  { key: "announcement", label: "Announcements" },
];

/**
 * Split a mixed list into assignment / material groups, in that order.
 *
 * "New since yesterday" listed both kinds interleaved, so a reading handout sat
 * between two things that were actually due. Work you have to do comes first.
 *
 * `showLabels` is false when only one group survives — a lone "Assignments"
 * heading over an all-assignment list is noise, not structure.
 */
export function groupPlannerItems(items) {
  const list = Array.isArray(items) ? items : [];
  const buckets = new Map(GROUP_ORDER.map((g) => [g.key, []]));
  const other = [];
  for (const item of list) {
    const kind = String(item?.kind || "").trim();
    if (buckets.has(kind)) buckets.get(kind).push(item);
    else other.push(item);
  }
  const groups = GROUP_ORDER
    .map(({ key, label }) => ({ key, label, items: buckets.get(key) }))
    .filter((g) => g.items.length > 0);
  // Anything with an unrecognised kind still has to render somewhere.
  if (other.length) groups.push({ key: "other", label: "Other", items: other });
  return { groups, showLabels: groups.length > 1 };
}

/**
 * Put work still to do above work already handed in, then order each half by
 * deadline.
 *
 * "New since yesterday" sorted purely by the caller's sort, so a submitted
 * assignment could sit above one the student still has to start. Whether it is
 * done is the first thing you want to know; when it is due is the second.
 * Being new is why an item is in this section — it says nothing about which of
 * the new things to open first, and posting order is not that answer.
 *
 * `pending` is passed in because submission state lives in app.js — this module
 * stays free of Classroom's data shape. `dueTime` is optional for the same
 * reason it is optional at the call site: the Planner's sort dropdown is the
 * student's explicit choice, and when they have made one it must survive. Omit
 * it and this is exactly the stable partition it was before.
 *
 * Work with no deadline sorts last inside its half rather than first. A missing
 * due date is not "due at the epoch"; an undated handout is the least urgent
 * thing on the list, not the most.
 */
export function sortPendingFirst(items, pending, { dueTime = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const rank = (item) => (item?.kind === "assignment" && !pending(item) ? 1 : 0);
  const due = (item) => {
    if (!dueTime) return 0;
    const raw = dueTime(item);
    // `Number(null)` is 0, so a null deadline would otherwise score as the
    // most urgent thing on the list. Nullish is missing, full stop.
    if (raw == null) return Infinity;
    const t = Number(raw);
    return Number.isFinite(t) ? t : Infinity;
  };
  // Equal deadlines are compared first, not subtracted: two undated items both
  // score Infinity, and Infinity - Infinity is NaN, which makes a comparator
  // return "unordered" and the sort arbitrary. Index breaks the tie instead, so
  // the order is stable across engines.
  const byDue = (a, b) => (a.due === b.due ? 0 : a.due - b.due);
  return list
    .map((item, i) => ({ item, i, rank: rank(item), due: due(item) }))
    .sort((a, b) => a.rank - b.rank || byDue(a, b) || a.i - b.i)
    .map(({ item }) => item);
}

/**
 * Is this the kind of "new" that "New since yesterday" means?
 *
 * The window is calendar-based, not a rolling 24 hours: everything posted since
 * midnight at the START of yesterday. Something posted yesterday morning is
 * still new this morning, which is the point of the section — but it drops out
 * when the date rolls over again, and never lasts a third day.
 *
 * `now` is a parameter because the bug this section actually had was about
 * time, not about filtering: nothing recomputed the list while the app stayed
 * open, so a standalone window left running for days showed whatever was new
 * on the day it was opened. The predicate below was always right; it just was
 * not asked again. `reportIsStale` in report-freshness.js is the other half.
 */
export function postedSinceYesterday(creationTime, now = new Date()) {
  if (!creationTime) return false;
  const created = new Date(creationTime);
  if (Number.isNaN(created.getTime())) return false;
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 1);
  return created >= since;
}
