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

export const CURRICULUM_SORTS = ["span", "alpha", "notes"];
export const DEFAULT_CURRICULUM_SORT = "span";

/** Normalize the Curriculum filter/sort controls. Unknown values fall back. */
export function curriculumControlsModel(value = {}) {
  const sort = CURRICULUM_SORTS.includes(value?.sort) ? value.sort : DEFAULT_CURRICULUM_SORT;
  return {
    q: String(value?.q == null ? "" : value.q).trim(),
    yearFrom: String(value?.yearFrom == null ? "" : value.yearFrom).trim(),
    yearTo: String(value?.yearTo == null ? "" : value.yearTo).trim(),
    sort,
  };
}

/**
 * Every year present in the corpus, ascending. The column axis, and the option
 * list for the year-range controls.
 */
export function curriculumYears(bundle) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  return [...new Set(notes.map((n) => n?.y).filter(Boolean))].sort();
}

/**
 * Build the matrix.
 *
 * `controls` narrows it: `q` matches a subject row or any course name inside
 * it, `yearFrom`/`yearTo` clip the column range (inclusive, order-insensitive),
 * and `sort` orders the rows.
 *
 * @returns {{years, rows, allYears, totalRows, filtered}}
 *   `years` are the columns actually shown; `allYears` is the unclipped axis so
 *   the controls can still offer years the current filter hides. Rows spanning
 *   two or more years come first under the default sort — seeing one subject
 *   continue across years is the whole point of the view — then alphabetically.
 */
export function curriculumModel(bundle, controls = {}) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const allYears = curriculumYears(bundle);
  const opts = curriculumControlsModel(controls);
  if (notes.length === 0) return { years: [], rows: [], allYears, totalRows: 0, filtered: false };

  // Order-insensitive: picking "2025-26 → 2023-24" means the same range.
  const bounds = [opts.yearFrom, opts.yearTo].filter((y) => allYears.includes(y)).sort();
  const lo = bounds.length === 2 ? bounds[0] : bounds.length === 1 && opts.yearFrom ? bounds[0] : "";
  const hi = bounds.length === 2 ? bounds[1] : bounds.length === 1 && opts.yearTo ? bounds[0] : "";
  const inRange = (y) => (!lo || y >= lo) && (!hi || y <= hi);

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
    if (!inRange(y)) continue;
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
      rows.set(key, { key, label: prettifySubjectLabel(entry.family || key || entry.name), byYear: new Map(), noteCount: 0 });
    }
    const row = rows.get(key);
    row.noteCount += entry.noteCount;
    if (!row.byYear.has(entry.y)) row.byYear.set(entry.y, []);
    row.byYear.get(entry.y).push({
      name: entry.name,
      y: entry.y,
      noteCount: entry.noteCount,
      topicCount: entry.topics.size,
      linked: entry.linked,
    });
  }

  const totalRows = rows.size;

  // Search matches the row label OR any course name on the row, so typing
  // "nae" finds the row even though its label is the folded subject key.
  const needle = opts.q.toLowerCase();
  const matches = (row) => {
    if (!needle) return true;
    if (row.label.toLowerCase().includes(needle)) return true;
    for (const list of row.byYear.values()) {
      for (const c of list) if (String(c.name).toLowerCase().includes(needle)) return true;
    }
    return false;
  };

  const sorted = [...rows.values()]
    .map((row) => ({ ...row, multiYear: row.byYear.size >= 2 }))
    .filter(matches)
    .sort((a, b) => {
      if (opts.sort === "alpha") return a.label.localeCompare(b.label);
      if (opts.sort === "notes") return b.noteCount - a.noteCount || a.label.localeCompare(b.label);
      if (a.multiYear !== b.multiYear) return a.multiYear ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

  // Only keep columns that still hold something after the row filter, so
  // searching one subject does not leave four empty year columns behind.
  const usedYears = new Set();
  for (const row of sorted) for (const y of row.byYear.keys()) usedYears.add(y);
  const shownYears = years.filter((y) => usedYears.has(y));

  return {
    years: shownYears,
    rows: sorted,
    allYears,
    totalRows,
    filtered: sorted.length !== totalRows,
  };
}

/**
 * Render the matrix into `container`.
 *
 * `onOpenCourse(name, year)` is called when a course chip is clicked — the
 * Study page hands it the Browse tab's course opener, so the matrix is a way
 * into the corpus rather than a dead end.
 *
 * `controls` is the current filter/sort state and `onControlsChange` is called
 * with the next state whenever the user touches the bar. The caller owns the
 * state (and its persistence); this function only renders it, which keeps the
 * whole view a pure function of `(bundle, controls)`.
 */
export function renderCurriculum(container, bundle, { onOpenCourse, controls = {}, onControlsChange } = {}) {
  if (!container) return;
  container.innerHTML = "";

  const opts = curriculumControlsModel(controls);
  const { years, rows, allYears, totalRows, filtered } = curriculumModel(bundle, opts);

  if (totalRows === 0 && !opts.q && !opts.yearFrom && !opts.yearTo) {
    container.innerHTML = `<div class="empty">No courses yet — build or import your notes from the Manage tab.</div>`;
    return;
  }

  if (onControlsChange) {
    container.appendChild(
      curriculumControlsBar(opts, allYears, rows.length, totalRows, filtered, onControlsChange),
    );
  }

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No subjects match these filters.";
    container.appendChild(empty);
    return;
  }

  const scroller = document.createElement("div");
  scroller.className = "curriculum-scroll";

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
    // The tint means "this subject continued across years" — the one thing the
    // matrix exists to show. Nothing said so, which just made it look like some
    // rows were arbitrarily selected.
    if (row.multiYear) {
      tr.title = `${row.label} ran across ${row.byYear.size} school years`;
    }
    tr.appendChild(cell("curriculum-row-label", row.label));
    for (const y of years) {
      const td = document.createElement("div");
      td.className = "curriculum-cell";
      const courses = row.byYear.get(y) || [];
      if (courses.length === 0) td.classList.add("curriculum-empty-cell");
      for (const course of courses) {
        td.appendChild(courseChip(course, onOpenCourse));
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  scroller.appendChild(table);
  container.appendChild(scroller);
}

/** The Curriculum filter/sort bar. Emits the whole next control state. */
function curriculumControlsBar(opts, allYears, shownRows, totalRows, filtered, onChange) {
  const bar = document.createElement("div");
  bar.className = "kb-controls";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Filter and sort the curriculum");

  const emit = (patch) => onChange({ ...opts, ...patch });

  const search = document.createElement("input");
  search.type = "search";
  search.id = "kbCurriculumSearch";
  search.placeholder = "Filter subjects or courses…";
  search.setAttribute("aria-label", "Filter subjects or courses");
  search.value = opts.q;
  search.addEventListener("input", () => emit({ q: search.value }));
  bar.appendChild(search);

  // A from/to pair rather than a single "year" dropdown: the matrix axis IS
  // years, so the useful control is which stretch of them to show, and the
  // range is what actually removes columns and makes the grid fit.
  bar.appendChild(
    field("From", yearSelect("kbCurriculumFrom", "Earliest year shown", allYears, opts.yearFrom, "Earliest", (v) => emit({ yearFrom: v }))),
  );
  bar.appendChild(
    field("To", yearSelect("kbCurriculumTo", "Latest year shown", allYears, opts.yearTo, "Latest", (v) => emit({ yearTo: v }))),
  );

  const sort = document.createElement("select");
  sort.id = "kbCurriculumSort";
  sort.setAttribute("aria-label", "Sort subjects");
  for (const [value, label] of [["span", "Longest-running"], ["alpha", "A–Z"], ["notes", "Most notes"]]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sort.appendChild(o);
  }
  sort.value = opts.sort;
  sort.addEventListener("change", () => emit({ sort: sort.value }));
  bar.appendChild(field("Sort", sort));

  const spacer = document.createElement("span");
  spacer.className = "kb-controls-spacer";
  bar.appendChild(spacer);

  const legend = document.createElement("span");
  legend.className = "kb-controls-legend";
  const swatch = document.createElement("span");
  swatch.className = "kb-controls-swatch";
  swatch.setAttribute("aria-hidden", "true");
  const legendText = document.createElement("span");
  legendText.textContent = "ran across multiple years";
  legend.append(swatch, legendText);
  bar.appendChild(legend);

  const count = document.createElement("span");
  count.className = "kb-controls-count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  count.textContent = filtered
    ? `${shownRows} of ${totalRows} subjects`
    : `${totalRows} subject${totalRows === 1 ? "" : "s"}`;
  bar.appendChild(count);

  const isDefault = !opts.q && !opts.yearFrom && !opts.yearTo && opts.sort === DEFAULT_CURRICULUM_SORT;
  if (!isDefault) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "link-btn kb-controls-reset";
    reset.textContent = "Reset";
    reset.addEventListener("click", () => onChange(curriculumControlsModel({})));
    bar.appendChild(reset);
  }
  return bar;
}

function field(labelText, control) {
  const wrap = document.createElement("label");
  wrap.className = "kb-controls-field";
  wrap.htmlFor = control.id;
  const label = document.createElement("span");
  label.className = "kb-controls-label";
  label.textContent = labelText;
  wrap.append(label, control);
  return wrap;
}

function yearSelect(id, ariaLabel, years, value, anyLabel, onChange) {
  const select = document.createElement("select");
  select.id = id;
  select.setAttribute("aria-label", ariaLabel);
  const any = document.createElement("option");
  any.value = "";
  any.textContent = anyLabel;
  select.appendChild(any);
  for (const y of years) {
    const o = document.createElement("option");
    o.value = y;
    o.textContent = y;
    select.appendChild(o);
  }
  select.value = years.includes(value) ? value : "";
  select.addEventListener("change", () => onChange(select.value));
  return select;
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
