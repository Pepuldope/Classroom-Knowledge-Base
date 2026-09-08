import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewDigest } from "../review-digest.js";
import { noteProgressKey } from "../study-progress.js";

// Progress is keyed by the note's stable key, not its array position. These
// fixture notes have no path, so they exercise the content-id fallback.
const key = noteProgressKey;

test("buildReviewDigest selects unopened notes and labels a weekly review plan", () => {
  const notes = [
    { t: "Old opened", course: "Math", y: "2023-24", topic: "Algebra" },
    { t: "New unopened", course: "Physics", y: "2025-26", topic: "Motion" },
    { t: "Another unopened", course: "Math", y: "2024-25", topic: "Geometry" },
  ];
  const digest = buildReviewDigest(notes, { [key(notes[0])]: { lastOpened: "2026-07-20" } }, 2);
  assert.equal(digest.title, "Your weekly review");
  assert.equal(digest.items.length, 2);
  assert.deepEqual(digest.items.map((item) => item.title), ["New unopened", "Another unopened"]);
  assert.match(digest.items[0].detail, /Physics/);
});

test("buildReviewDigest falls back to recently opened notes when everything was reviewed", () => {
  const notes = [
    { t: "Earlier", course: "Math", y: "2024-25", topic: "Algebra" },
    { t: "Latest", course: "Physics", y: "2025-26", topic: "Motion" },
  ];
  const digest = buildReviewDigest(notes, {
    [key(notes[0])]: { lastOpened: "2026-07-20" },
    [key(notes[1])]: { lastOpened: "2026-07-21" },
  }, 1);
  assert.equal(digest.items.length, 1);
  assert.equal(digest.items[0].title, "Latest");
  assert.match(digest.detail, /already explored/i);
});

test("digest entries survive the corpus being reordered", () => {
  // The reason the key changed: mergeBundles re-files notes, which moves every
  // index after the one it moved.
  const notes = [
    { p: "2024-25/vault/Math/Algebra/Earlier", t: "Earlier", course: "Math", y: "2024-25", topic: "Algebra" },
    { p: "2025-26/vault/Physics/Motion/Latest", t: "Latest", course: "Physics", y: "2025-26", topic: "Motion" },
  ];
  const progress = { [key(notes[0])]: { lastOpened: "2026-07-20", opened: 1 } };
  const before = buildReviewDigest(notes, progress, 1);
  const after = buildReviewDigest([notes[1], notes[0]], progress, 1);
  assert.equal(before.items[0].title, "Latest", "the unopened note is the one to review");
  assert.equal(after.items[0].title, "Latest", "and still is once the array order changes");
});
