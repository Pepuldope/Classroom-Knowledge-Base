// my-tasks.js — the student's own Planner tasks, for work Classroom never lists.
//
// Reported 2026-10-10: a weekly test the teacher never posts to Classroom had
// no way onto the Planner at all. These tasks live in the synced prefs
// document (section `myTasks`, see prefs-sync.js) so they follow the student
// between phone and laptop, and are handed to the Planner as assignment-shaped
// items so every list, sort and due chip treats them like the real thing.
//
// Pure: no DOM, no storage. `today` is an ISO date passed in, so the rollover
// rules below can be tested without waiting a week.

export const MY_TASK_PREFIX = "mine:";
export const MY_TASK_REPEATS = ["none", "weekly"];
export const MY_TASK_MAX = 200;
const TITLE_MAX = 200;
const COURSE_MAX = 120;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

const isoDate = (value) => (typeof value === "string" && DATE_RE.test(value) && !Number.isNaN(Date.parse(value)) ? value : "");
const toUtc = (iso) => Date.parse(`${iso}T00:00:00Z`);
const fromUtc = (t) => new Date(t).toISOString().slice(0, 10);

export function newMyTaskId(now = Date.now(), rand = Math.random) {
  return `t${now.toString(36)}${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** A stored task, cleaned. Null when it has no title or no valid date. */
export function normalizeMyTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim().slice(0, 40);
  const title = String(raw.title || "").trim().slice(0, TITLE_MAX);
  const date = isoDate(raw.date);
  if (!id || !title || !date) return null;
  const repeat = MY_TASK_REPEATS.includes(raw.repeat) ? raw.repeat : "none";
  const task = { id, title, date, repeat };
  const course = String(raw.course || "").trim().slice(0, COURSE_MAX);
  if (course) task.course = course;
  const doneThrough = isoDate(raw.doneThrough);
  if (doneThrough) task.doneThrough = doneThrough;
  return task;
}

/**
 * The date this task is currently due, or null when there is nothing left to do.
 *
 * A one-off task stays put — overdue if it is overdue — until it is ticked off.
 * A weekly task rolls forward on its own once its day has passed: a test that
 * happened last Tuesday is not something to hand in late, so it must not sit
 * on the Planner as "Overdue 6d". Ticking one off skips to the next week.
 */
export function currentOccurrence(task, today) {
  const t = normalizeMyTask(task);
  if (!t || !isoDate(today)) return null;
  if (t.repeat !== "weekly") {
    return t.doneThrough && t.doneThrough >= t.date ? null : t.date;
  }
  let at = toUtc(t.date);
  const now = toUtc(today);
  if (at < now) at += Math.ceil((now - at) / (7 * DAY_MS)) * 7 * DAY_MS;
  if (t.doneThrough) {
    const done = toUtc(t.doneThrough);
    if (at <= done) at += (Math.floor((done - at) / (7 * DAY_MS)) + 1) * 7 * DAY_MS;
  }
  return fromUtc(at);
}

/**
 * What ticking a task off does. A one-off is finished and removed (null); a
 * weekly one is marked done for this week and comes back for the next.
 */
export function completeMyTask(task, today) {
  const t = normalizeMyTask(task);
  if (!t) return null;
  if (t.repeat !== "weekly") return null;
  const occ = currentOccurrence(t, today);
  return occ ? { ...t, doneThrough: occ } : t;
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
    out.push({
      id: MY_TASK_PREFIX + task.id,
      kind: "assignment",
      custom: true,
      myTask: task,
      title: task.title,
      courseName: task.course || "",
      dueDate: { year, month, day },
      submission: null,
    });
  }
  return out;
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
