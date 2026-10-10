// my-tasks.js — the student's own Planner tasks, for work Classroom never lists.
//
// Reported 2026-10-10: a weekly test the teacher never posts to Classroom had
// no way onto the Planner at all. These tasks live in the synced prefs
// document (section `myTasks`, see prefs-sync.js) so they follow the student
// between phone and laptop, and are handed to the Planner as assignment-shaped
// items so every list, sort, due chip and the assignment panel treat them like
// the real thing.
//
// Pure: no DOM, no storage. `today` is an ISO date passed in, so the rollover
// rules below can be tested without waiting a week.

import { relatedCourseMaterials } from "./related-materials.js";

export const MY_TASK_PREFIX = "mine:";
export const MY_TASK_MAX = 200;

/**
 * How often a task comes back. `date` says which of them need a date picked:
 * a weekly test happens on a weekday, not on a date, so asking for one was a
 * question with no right answer (reported 2026-10-10).
 */
export const MY_TASK_REPEATS = [
  { value: "none", label: "Once", date: "When" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every school day (Mon–Fri)" },
  { value: "weekly", label: "Every week", days: true },
  { value: "biweekly", label: "Every 2 weeks", date: "Next one on" },
  { value: "monthly", label: "Every month", date: "Next one on" },
];
const REPEAT = new Map(MY_TASK_REPEATS.map((r) => [r.value, r]));
export const repeatNeedsDate = (repeat) => !!REPEAT.get(repeat)?.date;

// Monday first, the way a school week is read. Values are JS getDay() numbers.
export const WEEKDAYS = [
  { value: 1, short: "Mon" }, { value: 2, short: "Tue" }, { value: 3, short: "Wed" },
  { value: 4, short: "Thu" }, { value: 5, short: "Fri" }, { value: 6, short: "Sat" },
  { value: 0, short: "Sun" },
];

const TITLE_MAX = 200;
const COURSE_MAX = 120;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
/** Far enough to find the next monthly occurrence from any day. */
const SEARCH_DAYS = 400;

const isoDate = (value) => {
  if (typeof value !== "string" || !DATE_RE.test(value)) return "";
  const t = toUtc(value);
  return Number.isFinite(t) && fromUtc(t) === value ? value : "";
};
const toUtc = (iso) => Date.parse(`${iso}T00:00:00Z`);
const fromUtc = (t) => new Date(t).toISOString().slice(0, 10);
const dowOf = (iso) => new Date(toUtc(iso)).getUTCDay();

export function newMyTaskId(now = Date.now(), rand = Math.random) {
  return `t${now.toString(36)}${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** "2,4" or [2,4] -> [2,4], sorted Monday-first, de-duplicated. */
export function parseDays(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  // Blank entries are dropped before Number(), which reads "" as 0 — Sunday.
  const set = new Set(raw.map((d) => String(d).trim()).filter(Boolean).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  return WEEKDAYS.map((w) => w.value).filter((d) => set.has(d));
}

/** A stored task, cleaned. Null when it cannot be scheduled. */
export function normalizeMyTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim().slice(0, 40);
  const title = String(raw.title || "").trim().slice(0, TITLE_MAX);
  if (!id || !title) return null;
  const repeat = REPEAT.has(raw.repeat) ? raw.repeat : "none";
  const date = isoDate(raw.date);
  let days = parseDays(raw.days);
  // Weekly tasks saved before weekdays existed carried only a date.
  if (repeat === "weekly" && days.length === 0 && date) days = [dowOf(date)];
  if (repeatNeedsDate(repeat) && !date) return null;
  if (repeat === "weekly" && days.length === 0) return null;

  const task = { id, title, repeat };
  // Only the repeats that ask for a date keep one. The others are anchored to
  // today, so a stale date left over from switching the repeat cannot quietly
  // hold the task back.
  if (repeatNeedsDate(repeat)) task.date = date;
  if (repeat === "weekly") task.days = days.join(",");
  const course = String(raw.course || "").trim().slice(0, COURSE_MAX);
  if (course) task.course = course;
  const courseId = String(raw.courseId || "").trim().slice(0, 60);
  if (courseId) task.courseId = courseId;
  const doneThrough = isoDate(raw.doneThrough);
  if (doneThrough) task.doneThrough = doneThrough;
  return task;
}

function matchesDay(task, iso, days) {
  const dow = dowOf(iso);
  switch (task.repeat) {
    case "daily": return true;
    case "weekdays": return dow >= 1 && dow <= 5;
    case "weekly": return days.includes(dow);
    case "biweekly": {
      const apart = Math.round((toUtc(iso) - toUtc(task.date)) / DAY_MS);
      return apart >= 0 && apart % 14 === 0;
    }
    case "monthly": {
      const want = Number(task.date.slice(8, 10));
      const d = new Date(toUtc(iso));
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      // The 31st in a 30-day month is the 30th, not skipped.
      return d.getUTCDate() === Math.min(want, lastDay);
    }
    default: return false;
  }
}

/**
 * The date this task is currently due, or null when there is nothing left to do.
 *
 * A one-off task stays put — overdue if it is overdue — until it is ticked off.
 * A repeating task rolls forward on its own once its day has passed: a test
 * that happened last Tuesday is not something to hand in late, so it must not
 * sit on the Planner as "Overdue 6d". Ticking one off skips to the next one.
 */
export function currentOccurrence(task, today) {
  const t = normalizeMyTask(task);
  if (!t || !isoDate(today)) return null;
  if (t.repeat === "none") {
    return t.doneThrough && t.doneThrough >= t.date ? null : t.date;
  }
  let start = toUtc(today);
  if (t.date) start = Math.max(start, toUtc(t.date));
  if (t.doneThrough) start = Math.max(start, toUtc(t.doneThrough) + DAY_MS);
  const days = parseDays(t.days);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const iso = fromUtc(start + i * DAY_MS);
    if (matchesDay(t, iso, days)) return iso;
  }
  return null;
}

/**
 * What ticking a task off does. A one-off is finished and removed (null); a
 * repeating one is marked done for this occurrence and comes back for the next.
 */
export function completeMyTask(task, today) {
  const t = normalizeMyTask(task);
  if (!t || t.repeat === "none") return null;
  const occ = currentOccurrence(t, today);
  return occ ? { ...t, doneThrough: occ } : t;
}

/** "Every Tue, Thu", "Every month on the 13th" — for the card and the panel. */
export function repeatLabel(task) {
  const t = normalizeMyTask(task);
  if (!t || t.repeat === "none") return "";
  if (t.repeat === "weekly") {
    const days = parseDays(t.days);
    const names = WEEKDAYS.filter((w) => days.includes(w.value)).map((w) => w.short);
    return days.length === 7 ? "Every day" : `Every ${names.join(", ")}`;
  }
  if (t.repeat === "biweekly") return `Every 2nd ${WEEKDAYS.find((w) => w.value === dowOf(t.date)).short}`;
  if (t.repeat === "monthly") return `Monthly, day ${Number(t.date.slice(8, 10))}`;
  return REPEAT.get(t.repeat).label.replace(/ \(.*\)$/, "");
}

/** The tasks as Planner items, in the shape app.js's lists already read. */
export function myTaskPlannerItems(tasks, today) {
  const out = [];
  for (const raw of Array.isArray(tasks) ? tasks : []) {
    const task = normalizeMyTask(raw);
    if (!task) continue;
    const occ = currentOccurrence(task, today);
    if (!occ) continue;
    const [year, month, day] = occ.split("-").map(Number);
    const item = {
      id: MY_TASK_PREFIX + task.id,
      kind: "assignment",
      custom: true,
      myTask: task,
      title: task.title,
      courseName: task.course || "",
      dueDate: { year, month, day },
      submission: null,
    };
    if (task.courseId) item.courseId = task.courseId;
    out.push(item);
  }
  return out;
}

/**
 * The class material a task of the student's own probably needs.
 *
 * Classroom's own assignments are matched to material by title and by being
 * posted around the same time (related-materials.js). A task the student
 * typed has no posting date, and "Vocab test" has no title words the teacher
 * used — so it is matched as of TODAY: the same class, a shared word if there
 * is one, otherwise what was posted in the last week or so. For a weekly test
 * that is exactly the material it covers.
 */
export function myTaskClassMaterials(item, all, today, { limit = 6 } = {}) {
  if (!item || (!item.courseId && !item.courseName)) return [];
  const asOfToday = { ...item, creationTime: `${today}T12:00:00Z` };
  return relatedCourseMaterials(asOfToday, all, { limit });
}

/** Add or replace one task in a list, by id. */
export function upsertMyTask(tasks, task) {
  const t = normalizeMyTask(task);
  const list = (Array.isArray(tasks) ? tasks : []).map(normalizeMyTask).filter(Boolean);
  if (!t) return list;
  const i = list.findIndex((x) => x.id === t.id);
  if (i >= 0) list[i] = t;
  else list.push(t);
  return list.slice(-MY_TASK_MAX);
}

export function removeMyTask(tasks, id) {
  return (Array.isArray(tasks) ? tasks : []).map(normalizeMyTask).filter((t) => t && t.id !== id);
}
