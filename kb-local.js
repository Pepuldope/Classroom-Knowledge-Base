// kb-local.js — private, browser-local Knowledge Base persistence.
//
// Reuses archive.js's IndexedDB primitives and database instead of creating a
// second storage layer. The KB remains a distinct bundle under its own record
// IDs, so it cannot overwrite the raw Classroom archive.

import { idbGet, idbPut, idbDelete } from "./archive.js";
import { makeSortFn } from "./kb-client-search.js";

const BUNDLE_ID = "kb-bundle";
const META_ID = "kb-meta";

/** Validate the small public contract shared by KB ingestion and local storage. */
export function validateKbBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("KB bundle object required");
  }
  if (bundle.version !== 1) throw new Error("Unsupported KB bundle version 1 expected");
  if (!Array.isArray(bundle.notes)) throw new Error("KB bundle is missing its notes array");
  return bundle;
}

/** Save a validated KB bundle to the user's existing browser-local store. */
export async function saveKbBundle(bundle) {
  const valid = validateKbBundle(bundle);
  await idbPut({ id: BUNDLE_ID, data: valid });
  await idbPut({
    id: META_ID,
    noteCount: valid.notes.length,
    years: Array.isArray(valid.years) ? valid.years : [],
    generatedAt: valid.generatedAt || null,
    savedAt: new Date().toISOString(),
  });
  return valid;
}

/** Return the distinct years represented by one course, newest first. */
export function browseYearFacet(bundle, course = "") {
  const cleanCourse = String(course || "").trim();
  const years = new Set(
    (Array.isArray(bundle?.notes) ? bundle.notes : [])
      .filter((note) => !cleanCourse || (note?.course || "Uncategorised") === cleanCourse)
      .map((note) => String(note?.y || "").trim())
      .filter(Boolean),
  );
  return [...years].sort((a, b) => {
    const undated = (value) => value.toLowerCase() === "undated";
    return (undated(a) ? 1 : 0) - (undated(b) ? 1 : 0) || b.localeCompare(a);
  });
}

/** Build the no-network browse response for the user's local bundle. */
export function browseKbBundle(bundle, course = "", { year = "", kind = "", family = "", sort = "recency" } = {}) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const cleanCourse = String(course || "").trim();
  const cleanYear = String(year || "").trim();
  const cleanKind = String(kind || "").trim();
  const cleanFamily = String(family || "").trim();
  const sortKey = new Set(["relevance", "recency", "course", "title"]).has(sort) ? sort : "recency";
  const browseSnippet = (note) => {
    const source = String(note?.s || note?.x || "").trim();
    return source.length > 200 ? `${source.slice(0, 200)}…` : source;
  };
  const meta = {
    noteCount: notes.length,
    years: Array.isArray(bundle?.years) ? bundle.years : [...new Set(notes.map((note) => note?.y).filter(Boolean))].sort(),
    generatedAt: bundle?.generatedAt || null,
    updatedAt: bundle?.generatedAt || null,
  };
  const scopedNotes = notes.filter((note) =>
    (!cleanCourse || (note?.course || "Uncategorised") === cleanCourse) &&
    (!cleanYear || (note?.y || "") === cleanYear) &&
    (!cleanKind || (note?.kind || "") === cleanKind) &&
    (!cleanFamily || (note?.family || "") === cleanFamily)
  );
  if (cleanCourse) {
    return {
      meta,
      notes: scopedNotes
        .map((note) => ({
          t: note?.t || "",
          course: note?.course || "",
          y: note?.y || "",
          topic: note?.topic || null,
          kind: note?.kind || "",
          family: note?.family || "",
          p: note?.p || "",
          noteIndex: notes.indexOf(note),
          _score: 0,
          _snippet: browseSnippet(note),
        }))
        .sort(makeSortFn(sortKey)),
    };
  }
  const map = new Map();
  scopedNotes.forEach((note) => {
    const name = note?.course || "Uncategorised";
    const entry = map.get(name) || { course: name, count: 0, years: new Set() };
    entry.count += 1;
    if (note?.y) entry.years.add(note.y);
    map.set(name, entry);
  });
  return {
    meta,
    courses: [...map.values()]
      .map((entry) => ({ ...entry, years: [...entry.years].sort() }))
      .sort((a, b) => b.count - a.count || a.course.localeCompare(b.course)),
  };
}

export async function loadKbBundle() {
  const localHarness = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const testDelay = localHarness ? Number(window.__cwaTestLoadDelayMs) : 0;
  if (Number.isFinite(testDelay) && testDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(testDelay, 5000)));
  }
  const record = await idbGet(BUNDLE_ID);
  return record?.data ? validateKbBundle(record.data) : null;
}

/** Remove only the local KB records; the raw archive remains untouched. */
export async function removeKbBundle() {
  await idbDelete(BUNDLE_ID);
  await idbDelete(META_ID);
}
