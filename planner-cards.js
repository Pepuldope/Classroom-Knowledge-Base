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
