import test from "node:test";
import assert from "node:assert/strict";
import { mergeBundles, migrateArchiveBundle } from "../kb-merge.js";

const note = (over = {}) => ({
  p: "2024-25/vault/Math/Algebra/quadratics",
  t: "Quadratics",
  course: "Matematika",
  y: "2024-25",
  topic: "Algebra",
  kind: "note",
  s: "Solving quadratic equations",
  x: "body",
  ...over,
});

const bundle = (notes, over = {}) => ({
  version: 1,
  source: "classroom",
  generatedAt: "2026-01-01T00:00:00.000Z",
  years: [...new Set(notes.map((n) => n.y))].sort(),
  courses: [],
  notes,
  clusters: [],
  ...over,
});

test("past years and the current build become one corpus", () => {
  // The whole point: importing an archive must not throw away a Classroom
  // build, and building must not throw away the archive.
  const past = bundle([note({ p: "2023-24/a", y: "2023-24", course: "Dejepis" })]);
  const now = bundle([note({ p: "2024-25/b", y: "2024-25", course: "Matematika" })]);

  const merged = mergeBundles(past, now);
  assert.equal(merged.notes.length, 2);
  assert.deepEqual(merged.years, ["2023-24", "2024-25"]);
  assert.deepEqual(merged.courses.map((c) => c.name).sort(), ["Dejepis", "Matematika"]);
});

test("a note path collision replaces rather than duplicates", () => {
  const older = bundle([note({ t: "Old title" })]);
  const newer = bundle([note({ t: "New title" })]);

  const merged = mergeBundles(older, newer);
  assert.equal(merged.notes.length, 1, "same path must not duplicate");
  assert.equal(merged.notes[0].t, "New title", "incoming wins");
});

test("notes the incoming bundle does not cover survive", () => {
  const stored = bundle([note({ p: "a" }), note({ p: "b" }), note({ p: "c" })]);
  const partial = bundle([note({ p: "b", t: "Rebuilt" })]);

  const merged = mergeBundles(stored, partial);
  assert.deepEqual(merged.notes.map((n) => n.p).sort(), ["a", "b", "c"]);
  assert.equal(merged.notes.find((n) => n.p === "b").t, "Rebuilt");
});

test("every note ends up with a class-type family", () => {
  const merged = mergeBundles(bundle([note({ family: undefined })]), bundle([]));
  assert.ok(merged.notes[0].family !== undefined, "family should be derived");
});

test("an imported family is never overwritten", () => {
  const merged = mergeBundles(bundle([note({ family: "hand-picked" })]), bundle([]));
  assert.equal(merged.notes[0].family, "hand-picked");
});

test("course facets are recomputed from the merged notes", () => {
  const merged = mergeBundles(
    bundle([note({ p: "a", course: "Fyzika" }), note({ p: "b", course: "Fyzika" })]),
    bundle([note({ p: "c", course: "Fyzika" })]),
  );
  const fyzika = merged.courses.find((c) => c.name === "Fyzika");
  assert.equal(fyzika.noteCount, 3);
  // A course spans years once the corpus is merged, so a single year would lie.
  assert.equal(fyzika.y, null);
});

test("clusters survive and are not duplicated", () => {
  const cluster = { topics: [{ y: "2023-24", course: "Dejepis", topic: "SNP" }] };
  const merged = mergeBundles(
    bundle([note({ p: "a" })], { clusters: [cluster] }),
    bundle([note({ p: "b" })], { clusters: [cluster] }),
  );
  assert.equal(merged.clusters.length, 1);
});

test("the newer generatedAt wins", () => {
  const merged = mergeBundles(
    bundle([note({ p: "a" })], { generatedAt: "2026-01-01T00:00:00.000Z" }),
    bundle([note({ p: "b" })], { generatedAt: "2026-06-01T00:00:00.000Z" }),
  );
  assert.equal(merged.generatedAt, "2026-06-01T00:00:00.000Z");
});

test("mixing provenances is recorded rather than silently overwritten", () => {
  const merged = mergeBundles(
    bundle([note({ p: "a" })], { source: "vault" }),
    bundle([note({ p: "b" })], { source: "classroom" }),
  );
  assert.equal(merged.source, "mixed");
});

test("merging into an empty corpus keeps the incoming provenance", () => {
  const merged = mergeBundles(bundle([], { source: "classroom" }), bundle([note()], { source: "vault" }));
  assert.equal(merged.source, "vault");
});

test("pathless notes are kept, not collapsed onto each other", () => {
  const merged = mergeBundles(bundle([note({ p: null, t: "one" }), note({ p: "", t: "two" })]), bundle([]));
  assert.equal(merged.notes.length, 2);
});

test("tolerates missing and malformed input", () => {
  assert.equal(mergeBundles(null, null).notes.length, 0);
  assert.equal(mergeBundles(undefined, bundle([note()])).notes.length, 1);
  assert.equal(mergeBundles(bundle([note()]), { notes: "not an array" }).notes.length, 1);
  // Built literally: the bundle() helper would itself trip over these.
  const junky = { version: 1, notes: [note(), null, "junk", 42], years: [], courses: [], clusters: [] };
  assert.equal(mergeBundles(junky, bundle([])).notes.length, 1);
});

test("the merged bundle still satisfies the storage contract", () => {
  // kb-local.js validateKbBundle enforces exactly these two invariants.
  const merged = mergeBundles(bundle([note()]), bundle([note({ p: "z" })]));
  assert.equal(merged.version, 1);
  assert.ok(Array.isArray(merged.notes));
});

// --- migration -------------------------------------------------------------

test("a legacy Archive bundle gains the summaries it never had", () => {
  // Archive notes always stored s: null, which cost them the ×3 summary weight
  // in search. Migration runs them through the curated conversion.
  const legacy = bundle([note({ s: null, x: "Solve for x. Then check your answer." })], { source: "classroom" });
  const migrated = migrateArchiveBundle(legacy, null);
  assert.equal(migrated.notes.length, 1);
  assert.ok(migrated.notes[0].s, "summary should be derived during migration");
  assert.ok(migrated.notes[0].family !== undefined);
});

test("migration keeps the existing KB copy on a collision", () => {
  const legacy = bundle([note({ p: "shared", t: "Raw archive copy", s: null })]);
  const existing = bundle([note({ p: "shared", t: "Curated KB copy" })]);
  const migrated = migrateArchiveBundle(legacy, existing);
  assert.equal(migrated.notes.length, 1);
  assert.equal(migrated.notes[0].t, "Curated KB copy");
});

test("migration unions the two corpora", () => {
  const legacy = bundle([note({ p: "old", y: "2022-23" })]);
  const existing = bundle([note({ p: "new", y: "2024-25" })]);
  const migrated = migrateArchiveBundle(legacy, existing);
  assert.equal(migrated.notes.length, 2);
  assert.deepEqual(migrated.years, ["2022-23", "2024-25"]);
});

test("clusters from an offline export survive migration", () => {
  // kbBundleFromClassroomArchive works note-by-note and drops them, so they are
  // carried across explicitly.
  const cluster = { topics: [{ y: "2023-24", course: "Dejepis", topic: "SNP" }] };
  const legacy = bundle([note()], { clusters: [cluster] });
  const migrated = migrateArchiveBundle(legacy, null);
  assert.deepEqual(migrated.clusters, [cluster]);
});

test("an absent or empty Archive bundle leaves the KB untouched", () => {
  const existing = bundle([note()]);
  assert.equal(migrateArchiveBundle(null, existing), existing);
  assert.equal(migrateArchiveBundle(bundle([]), existing), existing);
  assert.equal(migrateArchiveBundle(null, null), null);
});
