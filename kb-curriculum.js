// kb-curriculum.js — the subject × year matrix, ported from the Archive view.
//
// This was the one thing the Archive page did that the Knowledge Base did not,
// and the reason it survives the merge: it answers "what have I been taught, and
// when" in a way neither search nor browse does.
//
// Rebuilt to read NOTES rather than the bundle's `courses` array. In a merged
// corpus a course spans years, so `courses[].y` is null by construction
// (kb-merge.js) — the year only exists on the notes. Deriving from notes also
// means the matrix is correct for any bundle, however it was ingested.

import { subjectKeyOf } from "./archive-builder.js";

/** Title-case a subject key for the row label. */
export function prettifySubjectLabel(value) {
  if (!value) return "(untitled)";
  return String(value).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build the matrix.
 *
 * @returns {{years: string[], rows: Array<{key, label, multiYear, byYear: Map<string, Array<{name, y, noteCount, topicCount, linked}>>}>}}
 *   Rows spanning two or more years come first — seeing one subject continue
 *   across years is the whole point of the view — then alphabetically.
 */
export function curriculumModel(bundle) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  if (notes.length === 0) return { years: [], rows: [] };

  // Topic keys that appear in a cross-link cluster. Only offline School Backup
  // exports populate clusters, so this is usually empty.
  const clusterTopicKeys = new Set();
  for (const cluster of Array.isArray(bundle?.clusters) ? bundle.clusters : []) {
    for (const t of Array.isArray(cluster?.topics) ? cluster.topics : []) {
      clusterTopicKeys.add(`${t.y}|${t.course}|${t.topic}`);
    }
  }

  // One entry per (course, year) pair actually present in the notes.
  const pairs = new Map();
  for (const note of notes) {
    if (!note || typeof note !== "object") continue;
    const name = note.course || "Uncategorized";
    const y = note.y || "undated";
    const key = `${name}|${y}`;
    let entry = pairs.get(key);
    if (!entry) {
      entry = { name, y, family: note.family || "", noteCount: 0, topics: new Set(), linked: false };
      pairs.set(key, entry);
    }
    entry.noteCount += 1;
    entry.topics.add(note.topic || "Uncategorized");
    if (!entry.family && note.family) entry.family = note.family;
    if (clusterTopicKeys.has(`${note.y}|${note.course}|${note.topic}`)) entry.linked = true;
  }

  const years = [...new Set([...pairs.values()].map((e) => e.y))].sort();

  const rows = new Map();
  for (const entry of pairs.values()) {
    // Group by class-type family when one was derived, else by a folded course
    // name with year/track tokens stripped, so "Math Y3" and "Math Y4" land on
    // one row without any hand-curated mapping.
    const key = entry.family || subjectKeyOf(entry.name);
    if (!rows.has(key)) {
      // Label from the KEY, not the first course name. Naming the row after
      // whichever course happened to be seen first labelled a row spanning
      // Y3 and Y4 "Matematika Y3", which reads as a single year.
      rows.set(key, { key, label: prettifySubjectLabel(entry.family || key || entry.name), byYear: new Map() });
    }
    const row = rows.get(key);
    if (!row.byYear.has(entry.y)) row.byYear.set(entry.y, []);
    row.byYear.get(entry.y).push({
      name: entry.name,
      y: entry.y,
      noteCount: entry.noteCount,
      topicCount: entry.topics.size,
      linked: entry.linked,
    });
  }

  const sorted = [...rows.values()]
    .map((row) => ({ ...row, multiYear: row.byYear.size >= 2 }))
    .sort((a, b) => {
      if (a.multiYear !== b.multiYear) return a.multiYear ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

  return { years, rows: sorted };
}

/**
 * Render the matrix into `container`.
 *
 * `onOpenCourse(name, year)` is called when a course chip is clicked — the
 * Study page hands it the Browse tab's course opener, so the matrix is a way
 * into the corpus rather than a dead end.
 */
export function renderCurriculum(container, bundle, { onOpenCourse } = {}) {
  if (!container) return;
  container.innerHTML = "";

  const { years, rows } = curriculumModel(bundle);
  if (rows.length === 0) {
    container.innerHTML = `<div class="empty">No courses yet — build or import your notes from the Manage tab.</div>`;
    return;
  }

  const table = document.createElement("div");
  table.className = "curriculum-table";
  table.style.setProperty("--curriculum-cols", String(years.length));

  const header = document.createElement("div");
  header.className = "curriculum-row curriculum-header";
  header.appendChild(cell("curriculum-row-label", ""));
  for (const y of years) header.appendChild(cell("curriculum-col-label", y));
  table.appendChild(header);

  for (const row of rows) {
    const tr = document.createElement("div");
    tr.className = "curriculum-row" + (row.multiYear ? " curriculum-row-multi" : "");
    tr.appendChild(cell("curriculum-row-label", row.label));
    for (const y of years) {
      const td = document.createElement("div");
      td.className = "curriculum-cell";
      for (const course of row.byYear.get(y) || []) {
        td.appendChild(courseChip(course, onOpenCourse));
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  container.appendChild(table);
}

function courseChip(course, onOpenCourse) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "curriculum-chip";

  const name = document.createElement("span");
  name.className = "curriculum-chip-name";
  // textContent, not innerHTML: course names come from Classroom.
  name.textContent = course.name;
  if (course.linked) {
    const badge = document.createElement("span");
    badge.className = "curriculum-chip-badge";
    badge.title = "Linked topics elsewhere in your notes";
    badge.textContent = " 🔗";
    name.appendChild(badge);
  }

  const meta = document.createElement("span");
  meta.className = "curriculum-chip-meta";
  meta.textContent = `${course.topicCount} topic${course.topicCount === 1 ? "" : "s"} · ${course.noteCount} note${course.noteCount === 1 ? "" : "s"}`;

  chip.append(name, meta);
  chip.addEventListener("click", () => onOpenCourse?.(course.name, course.y));
  return chip;
}

function cell(className, text) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}
