// What the browser-local database keeps, and what it must let go of.
import test from "node:test";
import assert from "node:assert/strict";
import { migrateNoteProgress, recordNoteProgress, noteProgressKey } from "../study-progress.js";
import { isStaleKbBuildCheckpoint, KB_CHECKPOINT_MAX_AGE_DAYS } from "../kb-local-status.js";
import { mergeBundles } from "../kb-merge.js";
import { buildReviewDigest } from "../review-digest.js";

const NOTES = [
  { p: "2024-25/vault/NaE Y3 3.T/S1/Pitch", t: "Pitch", course: "NaE Y3 3.T", y: "2024-25" },
  { p: "2023-24/vault/ELA 1/S1/Essay", t: "Essay", course: "ELA 1", y: "2023-24" },
  { p: "2023-24/vault/GLO 1/S1/Map", t: "Map", course: "GLO 1", y: "2023-24" },
];

test("progress follows the note, not its position in the array", () => {
  // Recorded against "Essay" while it sat at index 1.
  const legacy = { 1: { opened: 3, lastOpened: "2026-09-07" } };
  const migrated = migrateNoteProgress(legacy, NOTES);
  assert.deepEqual(migrated, { "2023-24/vault/ELA 1/S1/Essay": { opened: 3, lastOpened: "2026-09-07" } });

  // A rebuild re-files NaE Y3 into its correct year. mergeBundles deletes the
  // old path and appends the new one, so every index shifts — which used to
  // hand "Essay"'s three opens to whatever note landed at index 1.
  const merged = mergeBundles({ version: 1, notes: NOTES }, {
    version: 1,
    notes: [{ p: "2025-26/vault/NaE Y3 3.T/S1/Pitch", t: "Pitch", course: "NaE Y3 3.T", y: "2025-26" }],
  });
  assert.notEqual(merged.notes[1].t, "Essay", "the fixture must actually reorder, or this proves nothing");
  const after = migrateNoteProgress(migrated, merged.notes);
  assert.deepEqual(after, migrated, "the record still points at Essay");
});

test("progress for notes that no longer exist is dropped", () => {
  const progress = {
    "2023-24/vault/ELA 1/S1/Essay": { opened: 2, lastOpened: "2026-09-01" },
    "2019-20/vault/Deleted Course/S1/Gone": { opened: 9, lastOpened: "2026-01-01" },
  };
  const cleaned = migrateNoteProgress(progress, NOTES);
  assert.deepEqual(Object.keys(cleaned), ["2023-24/vault/ELA 1/S1/Essay"]);
});

test("migration is idempotent and safe to run on every load", () => {
  const once = migrateNoteProgress({ 1: { opened: 3, lastOpened: "2026-09-07" } }, NOTES);
  assert.deepEqual(migrateNoteProgress(once, NOTES), once);
  assert.deepEqual(migrateNoteProgress({}, NOTES), {});
  assert.deepEqual(migrateNoteProgress(null, NOTES), {});
  assert.deepEqual(migrateNoteProgress({ 1: { opened: 1 } }, []), {});
});

test("a note with no path still gets a stable content key", () => {
  const note = { t: "Pitch", course: "NaE", y: "2025-26", topic: "S1" };
  assert.equal(noteProgressKey(note), "NaE|2025-26|Pitch|S1");
  assert.equal(noteProgressKey({}), "");
  assert.equal(noteProgressKey(NOTES[0]), "2024-25/vault/NaE Y3 3.T/S1/Pitch");
});

test("recording progress keys off the note it was given", () => {
  const next = recordNoteProgress({}, NOTES[1], "2026-09-08");
  assert.deepEqual(next, { "2023-24/vault/ELA 1/S1/Essay": { opened: 1, lastOpened: "2026-09-08" } });
  // Same day twice is one visit.
  assert.equal(recordNoteProgress(next, NOTES[1], "2026-09-08")["2023-24/vault/ELA 1/S1/Essay"].opened, 1);
  assert.equal(recordNoteProgress(next, NOTES[1], "2026-09-09")["2023-24/vault/ELA 1/S1/Essay"].opened, 2);
});

test("the review digest reads progress by the same key", () => {
  const progress = { "2023-24/vault/ELA 1/S1/Essay": { opened: 1, lastOpened: "2026-09-07" } };
  const digest = buildReviewDigest(NOTES, progress, 3);
  assert.ok(!digest.items.some((i) => i.title === "Essay"), "an opened note is not an unexplored one");
  assert.equal(digest.items.length, 2);
});

test("an interrupted build stops being resumable once it goes stale", () => {
  const now = "2026-09-08T12:00:00.000Z";
  assert.equal(isStaleKbBuildCheckpoint("2026-09-08T09:00:00.000Z", now), false, "hours old is resumable");
  assert.equal(isStaleKbBuildCheckpoint("2026-09-03T12:00:00.000Z", now), false, "five days old is resumable");
  assert.equal(isStaleKbBuildCheckpoint("2026-08-20T12:00:00.000Z", now), true, "a fortnight old is not");
  // A checkpoint written before this field existed cannot be aged, so it goes.
  assert.equal(isStaleKbBuildCheckpoint(undefined, now), true);
  assert.equal(isStaleKbBuildCheckpoint("nonsense", now), true);
  // A clock that jumped backwards is not evidence of freshness.
  assert.equal(isStaleKbBuildCheckpoint("2026-09-09T12:00:00.000Z", now), true);
  assert.equal(KB_CHECKPOINT_MAX_AGE_DAYS, 7);
});
