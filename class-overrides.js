// class-overrides.js — the student's own answer to "what kind of class is this".
//
// deriveFamily reads a category out of a course name, and it is wrong often
// enough to matter: a name is all it has, and names are written by teachers for
// other people. Peter, 2026-09-16: "make people able to rearrange them as they
// please so they can fix errors."
//
// So the rules are a DEFAULT and this is the answer. An override is stored per
// course name — not per note and not per course id — because that is the thing
// the student sees on the board and the thing that stays stable when the corpus
// is rebuilt from Classroom or merged with an imported year.
//
// Shape is an array of { id, family } rather than an object, so it drops
// straight into the existing tracked-section sync (prefs-sync.js): moving a
// class on the phone reaches the laptop, and moving one BACK to automatic is a
// removal, which the tombstone journal already knows how to survive.

import { deriveFamily, CLASS_FAMILIES } from "./kb-client-search.js";

/** The column an uncategorised class sits in. Not a family — the absence of one. */
export const UNCATEGORISED = "";
export const UNCATEGORISED_LABEL = "Not sorted yet";

const MAX_COURSE_NAME = 240;
/** More classes than any student has; the cap is only to bound what is stored. */
const MAX_OVERRIDES = 500;

/**
 * Normalize the stored list. An override naming a family the app no longer
 * offers is dropped rather than kept: it would render as a column that does
 * not exist, and the class is better off back on the rules.
 */
export function classFamilyOverridesModel(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const id = typeof item?.id === "string" ? item.id.trim().slice(0, MAX_COURSE_NAME) : "";
    const family = typeof item?.family === "string" ? item.family.trim() : "";
    if (!id || seen.has(id)) continue;
    if (!CLASS_FAMILIES.includes(family)) continue;
    seen.add(id);
    out.push({ id, family });
    if (out.length >= MAX_OVERRIDES) break;
  }
  return out;
}

/** Course name -> chosen family. */
export function familyOverrideMap(overrides) {
  return new Map(classFamilyOverridesModel(overrides).map((o) => [o.id, o.family]));
}

/** The category a course actually has: the student's choice, else the rules'. */
export function effectiveFamily(courseName, overrides) {
  const map = overrides instanceof Map ? overrides : familyOverrideMap(overrides);
  const chosen = map.get(String(courseName || "").trim());
  return chosen || deriveFamily(courseName);
}

/**
 * Stamp the effective family onto a bundle's notes and courses.
 *
 * Applied when the corpus is loaded and again whenever the board changes, so
 * every consumer — search's class-type facet, Browse, the Curriculum matrix —
 * keeps reading `note.family` and needs to know nothing about overrides.
 *
 * Returns the bundle UNCHANGED when there is nothing to apply, so the common
 * case does not copy a few thousand notes for no reason.
 */
export function applyFamilyOverrides(bundle, overrides) {
  const map = familyOverrideMap(overrides);
  if (map.size === 0 || !bundle) return bundle;
  const notes = Array.isArray(bundle.notes) ? bundle.notes : [];
  const courses = Array.isArray(bundle.courses) ? bundle.courses : [];
  return {
    ...bundle,
    notes: notes.map((note) => {
      const chosen = map.get(String(note?.course || "").trim());
      return chosen && note?.family !== chosen ? { ...note, family: chosen } : note;
    }),
    courses: courses.map((course) => {
      const chosen = map.get(String(course?.name || "").trim());
      return chosen && course?.family !== chosen ? { ...course, family: chosen } : course;
    }),
  };
}

/**
 * The board: one column per category, plus "Not sorted yet" for the classes the
 * rules could not place.
 *
 * Derived from NOTES rather than `bundle.courses`, for the same reason
 * curriculumModel is: in a merged corpus `courses` is a secondary index that an
 * imported year may not have contributed to, while every note names its course.
 *
 * Empty columns are kept. A board you can drag onto needs somewhere to drop.
 */
export function classBoardModel(bundle, overrides) {
  const map = familyOverrideMap(overrides);
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const byCourse = new Map();
  for (const note of notes) {
    const name = String(note?.course || "").trim();
    if (!name) continue;
    if (!byCourse.has(name)) byCourse.set(name, { name, noteCount: 0, years: new Set() });
    const entry = byCourse.get(name);
    entry.noteCount++;
    if (note?.y) entry.years.add(note.y);
  }

  const columns = new Map(
    [...CLASS_FAMILIES, UNCATEGORISED].map((family) => [family, {
      family,
      label: family || UNCATEGORISED_LABEL,
      classes: [],
    }]),
  );

  for (const entry of [...byCourse.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const chosen = map.get(entry.name) || "";
    const derived = deriveFamily(entry.name);
    const family = chosen || derived;
    const column = columns.get(family) || columns.get(UNCATEGORISED);
    column.classes.push({
      name: entry.name,
      noteCount: entry.noteCount,
      years: [...entry.years].sort(),
      // Shown on the card, so a student can tell what they changed from what
      // the app guessed — and can put it back.
      overridden: !!chosen && chosen !== derived,
      derived,
    });
  }

  const all = [...columns.values()];
  return {
    // "Not sorted yet" leads: it is the column with work in it.
    columns: [all[all.length - 1], ...all.slice(0, -1)],
    totalClasses: byCourse.size,
    overriddenCount: all.reduce((n, c) => n + c.classes.filter((k) => k.overridden).length, 0),
  };
}

/**
 * Move one class into a column.
 *
 * Dropping a class into the column the RULES would have chosen removes the
 * override rather than recording one — otherwise "put it back" would leave a
 * stored preference behind that silently stops tracking an improved rule.
 */
export function moveClassToFamily(overrides, courseName, family) {
  const name = String(courseName || "").trim().slice(0, MAX_COURSE_NAME);
  if (!name) return classFamilyOverridesModel(overrides);
  const rest = classFamilyOverridesModel(overrides).filter((o) => o.id !== name);
  if (!CLASS_FAMILIES.includes(family)) return rest;      // back to automatic
  if (deriveFamily(name) === family) return rest;          // the rules already agree
  return classFamilyOverridesModel([...rest, { id: name, family }]);
}
