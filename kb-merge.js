// kb-merge.js — combine note bundles into one corpus.
//
// The Study page has a single searchable set of notes: past school years
// (imported from a School Backup export) and the current Classroom build live
// together, with the year as a filter rather than a separate page.
//
// Before this, every ingestion path REPLACED the stored bundle — building from
// Classroom threw away an imported archive, and importing an archive threw away
// the build. Two separate IndexedDB records (`bundle` and `kb-bundle`) papered
// over that by keeping two corpora, which is exactly the split being removed.
//
// Dedupe is by note path `p`, matching the semantics `appendBundle` already uses
// server-side (api/kb-store.js): a note whose path already exists REPLACES the
// stored one, so re-running a build updates in place instead of duplicating.

import { kbBundleFromClassroomArchive } from "./kb-client-build.js";
import { deriveFamily } from "./kb-client-search.js";

const EMPTY = { version: 1, source: "classroom", notes: [], years: [], courses: [], clusters: [] };

function notesOf(bundle) {
  return Array.isArray(bundle?.notes) ? bundle.notes : [];
}

/**
 * Course facets, recomputed from the merged notes rather than carried over.
 *
 * `y` stays null: a course spans years in a merged corpus, so a single value
 * would be a lie. Anything needing course-by-year (the Curriculum matrix) reads
 * the notes, which carry the real year.
 */
function coursesFromNotes(notes) {
  const counts = new Map();
  for (const note of notes) {
    const name = note?.course || "Uncategorized";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, noteCount]) => ({ name, y: null, family: deriveFamily(name), noteCount }));
}

function mergeClusters(base, incoming) {
  const out = [];
  const seen = new Set();
  for (const cluster of [...(base?.clusters || []), ...(incoming?.clusters || [])]) {
    const key = JSON.stringify(cluster);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cluster);
  }
  return out;
}

function newerOf(a, b) {
  const ta = Date.parse(a || "");
  const tb = Date.parse(b || "");
  if (!Number.isFinite(ta)) return b || null;
  if (!Number.isFinite(tb)) return a || null;
  return ta >= tb ? a : b;
}

/**
 * Merge `incoming` into `base`, returning a new bundle. Incoming notes win on a
 * path collision, so the freshest ingestion is authoritative for anything it
 * covers while everything it does not cover survives.
 */
export function mergeBundles(base, incoming) {
  const left = base && typeof base === "object" ? base : EMPTY;
  const right = incoming && typeof incoming === "object" ? incoming : EMPTY;

  const byPath = new Map();
  let pathless = 0;
  const absorb = (note) => {
    if (!note || typeof note !== "object") return;
    // Give every note a family so the class-type facet is populated across the
    // whole corpus, without overwriting one that was imported.
    const enriched = note.family ? note : { ...note, family: deriveFamily(note.course) };
    if (note.p != null && note.p !== "") byPath.set(note.p, enriched);
    else byPath.set(`__pathless_${pathless++}`, enriched);
  };
  notesOf(left).forEach(absorb);
  notesOf(right).forEach(absorb);

  const notes = [...byPath.values()];
  const years = [...new Set(notes.map((n) => n?.y).filter(Boolean))].sort();

  const leftHasNotes = notesOf(left).length > 0;
  const source = !leftHasNotes
    ? right.source || left.source || "classroom"
    : left.source === right.source
      ? left.source
      : "mixed";

  const metadata = left.metadata || right.metadata
    ? { ...(left.metadata || {}), ...(right.metadata || {}) }
    : null;

  return {
    version: 1,
    source,
    generatedAt: newerOf(left.generatedAt, right.generatedAt) || new Date().toISOString(),
    years,
    courses: coursesFromNotes(notes),
    notes,
    clusters: mergeClusters(left, right),
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Fold a legacy Archive bundle into the KB corpus.
 *
 * The Archive stored raw Classroom notes with `s` (summary) always null and no
 * `family`, so it is normalized through the existing curated conversion first —
 * that derives the summary search weights ×3 and stamps the class-type facet.
 * The existing KB bundle is passed as `incoming` so it wins any path collision:
 * it is the curated copy, and a rebuild should not be undone by a stale import.
 */
export function migrateArchiveBundle(archiveBundle, kbBundle) {
  if (!archiveBundle || !Array.isArray(archiveBundle.notes) || archiveBundle.notes.length === 0) {
    return kbBundle || null;
  }
  const normalized = kbBundleFromClassroomArchive(archiveBundle);
  // Clusters only ever come from an offline School Backup export and are lost by
  // the note-level conversion, so carry them across explicitly.
  normalized.clusters = Array.isArray(archiveBundle.clusters) ? archiveBundle.clusters : [];
  return mergeBundles(normalized, kbBundle);
}
