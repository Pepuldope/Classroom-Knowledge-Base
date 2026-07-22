import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewDigest } from "../review-digest.js";

test("buildReviewDigest selects unopened notes and labels a weekly review plan", () => {
  const notes = [
    { t: "Old opened", course: "Math", y: "2023-24", topic: "Algebra" },
    { t: "New unopened", course: "Physics", y: "2025-26", topic: "Motion" },
    { t: "Another unopened", course: "Math", y: "2024-25", topic: "Geometry" },
  ];
  const digest = buildReviewDigest(notes, { "0": { lastOpened: "2026-07-20" } }, 2);
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
    "0": { lastOpened: "2026-07-20" },
    "1": { lastOpened: "2026-07-21" },
  }, 1);
  assert.equal(digest.items.length, 1);
  assert.equal(digest.items[0].title, "Latest");
  assert.match(digest.detail, /already explored/i);
});
