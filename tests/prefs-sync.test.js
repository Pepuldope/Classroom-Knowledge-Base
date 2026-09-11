import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeDateSet, mergeNoteProgress, mergeTracked, trackChanges, trackedIds,
  trackedRecords, trackedModel, mergeSyncedPrefs, TOMBSTONE_TTL_MS,
  MAX_TRACKED, MAX_PROGRESS_ENTRIES, MAX_DATES,
} from "../prefs-sync.js";

const NOW = Date.parse("2026-09-11T10:00:00Z");
const ago = (ms) => NOW - ms;
const DAY = 24 * 60 * 60 * 1000;

// --- the streak: grow-only -------------------------------------------------

test("two devices' study days are unioned, never chosen between", () => {
  const phone = ["2026-09-08", "2026-09-09"];
  const laptop = ["2026-09-09", "2026-09-10"];
  assert.deepEqual(mergeDateSet(phone, laptop),
    ["2026-09-08", "2026-09-09", "2026-09-10"]);
  // The whole point: neither device's days are lost, in either order.
  assert.deepEqual(mergeDateSet(laptop, phone), mergeDateSet(phone, laptop));
});

test("merging a streak twice changes nothing", () => {
  const a = ["2026-09-08"], b = ["2026-09-10"];
  const once = mergeDateSet(a, b);
  assert.deepEqual(mergeDateSet(once, b), once, "idempotent");
  assert.deepEqual(mergeDateSet(once, once), once);
});

test("only real calendar dates survive a merge", () => {
  assert.deepEqual(mergeDateSet(["2026-9-8", "nonsense", "", null], ["2026-09-08"]),
    ["2026-09-08"]);
  assert.deepEqual(mergeDateSet(null, undefined), []);
});

test("an over-long streak drops its oldest days, not its newest", () => {
  const many = Array.from({ length: MAX_DATES + 50 }, (_, i) =>
    new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
  const merged = mergeDateSet(many, []);
  assert.equal(merged.length, MAX_DATES);
  assert.equal(merged.at(-1), many.at(-1), "the recent end is what a streak reads");
});

// --- progress: high-water marks -------------------------------------------

test("progress takes the larger count and the later date per note", () => {
  const phone = { "math/algebra.md": { opened: 3, lastOpened: "2026-09-10" } };
  const laptop = { "math/algebra.md": { opened: 1, lastOpened: "2026-09-11" } };
  assert.deepEqual(mergeNoteProgress(phone, laptop),
    { "math/algebra.md": { opened: 3, lastOpened: "2026-09-11" } });
  assert.deepEqual(mergeNoteProgress(laptop, phone), mergeNoteProgress(phone, laptop));
});

test("opened counts are maxed, not summed — merging repeats must not inflate", () => {
  // This is the trap: summing is more "correct" for a single merge and wrong
  // for the second one, because the same two records are merged on every sync.
  const a = { n: { opened: 2 } };
  const b = { n: { opened: 3 } };
  const once = mergeNoteProgress(a, b);
  assert.equal(once.n.opened, 3);
  assert.equal(mergeNoteProgress(once, b).n.opened, 3, "merging again must not climb");
  assert.equal(mergeNoteProgress(mergeNoteProgress(once, b), a).n.opened, 3);
});

test("notes only one device has ever opened are kept", () => {
  const merged = mergeNoteProgress({ a: { opened: 1 } }, { b: { opened: 1 } });
  assert.deepEqual(Object.keys(merged).sort(), ["a", "b"]);
});

test("empty and malformed progress entries are dropped", () => {
  assert.deepEqual(mergeNoteProgress({ a: { opened: 0 }, b: null, c: "x" }, {}), {});
  assert.deepEqual(mergeNoteProgress(null, []), {});
  assert.deepEqual(mergeNoteProgress({ d: { opened: 0, lastOpened: "bad" } }, {}), {});
});

test("over the progress cap the least recently studied notes go first", () => {
  const big = {};
  for (let i = 0; i < MAX_PROGRESS_ENTRIES + 10; i++) {
    big[`note-${i}`] = { opened: 1, lastOpened: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10) };
  }
  const merged = mergeNoteProgress(big, {});
  assert.equal(Object.keys(merged).length, MAX_PROGRESS_ENTRIES);
  assert.ok(merged[`note-${MAX_PROGRESS_ENTRIES + 9}`], "the newest is kept");
  assert.ok(!merged["note-0"], "the oldest is dropped");
});

// --- tracked sets: the ones that actually conflict -------------------------

test("an unpin on one device is not undone by the other's stale copy", () => {
  // THE bug this whole shape exists for. A plain union resurrects the pin.
  const laptop = trackChanges({ a1: { at: ago(10 * DAY) } }, [], { now: NOW });
  const phoneStale = { a1: { at: ago(10 * DAY) } };
  const merged = mergeTracked(laptop, phoneStale, { now: NOW });
  assert.deepEqual(trackedIds(merged, { now: NOW }), [], "the pin came back from the dead");
  assert.equal(merged.a1.d, 1);
});

test("a re-pin after a delete wins, because it happened later", () => {
  const deleted = { a1: { at: ago(2 * DAY), d: 1 } };
  const repinned = { a1: { at: NOW } };
  assert.deepEqual(trackedIds(mergeTracked(deleted, repinned, { now: NOW }), { now: NOW }), ["a1"]);
  assert.deepEqual(trackedIds(mergeTracked(repinned, deleted, { now: NOW }), { now: NOW }), ["a1"]);
});

test("a simultaneous add and delete resolves the same way on both devices", () => {
  // Deterministic or the two devices disagree forever. Delete wins; the user
  // can undo that by pinning again, which is the recoverable direction.
  const add = { a1: { at: NOW } };
  const del = { a1: { at: NOW, d: 1 } };
  assert.equal(mergeTracked(add, del, { now: NOW }).a1.d, 1);
  assert.equal(mergeTracked(del, add, { now: NOW }).a1.d, 1);
});

test("each device keeps what only it pinned", () => {
  const phone = trackChanges({}, ["a1"], { now: ago(DAY) });
  const laptop = trackChanges({}, ["a2"], { now: NOW });
  assert.deepEqual(trackedIds(mergeTracked(phone, laptop, { now: NOW }), { now: NOW }).sort(),
    ["a1", "a2"]);
});

test("expired tombstones are forgotten so the blob cannot only grow", () => {
  const old = { gone: { at: ago(TOMBSTONE_TTL_MS + DAY), d: 1 } };
  assert.deepEqual(trackedModel(old, { now: NOW }), {});
  const fresh = { gone: { at: ago(TOMBSTONE_TTL_MS - DAY), d: 1 } };
  assert.equal(trackedModel(fresh, { now: NOW }).gone.d, 1);
});

test("re-saving an unchanged list does not restamp it", () => {
  // A restamp would win races it should lose, and churn the synced blob.
  const first = trackChanges({}, ["a1", "a2"], { now: ago(DAY) });
  const again = trackChanges(first, ["a1", "a2"], { now: NOW });
  assert.deepEqual(again, first);
});

test("trackChanges records both the addition and the removal it finds", () => {
  const before = trackChanges({}, ["a1", "a2"], { now: ago(DAY) });
  const after = trackChanges(before, ["a2", "a3"], { now: NOW });
  assert.equal(after.a1.d, 1, "a1 was removed");
  assert.equal(after.a1.at, NOW);
  assert.equal(after.a2.at, ago(DAY), "a2 was untouched");
  assert.equal(after.a3.at, NOW, "a3 is new");
  assert.deepEqual(trackedIds(after, { now: NOW }), ["a2", "a3"]);
});

test("pinned notes carry their title across, and a retitle is a change", () => {
  const fields = ["title"];
  const before = trackChanges({}, ["n1"], { now: ago(DAY), fields, payloads: { n1: { title: "Quadratics" } } });
  assert.deepEqual(trackedRecords(before, { now: NOW, fields }), [{ id: "n1", title: "Quadratics" }]);
  const after = trackChanges(before, ["n1"], { now: NOW, fields, payloads: { n1: { title: "Quadratic equations" } } });
  assert.equal(after.n1.at, NOW, "a changed title is a change worth stamping");
  assert.deepEqual(trackedRecords(after, { now: NOW, fields }), [{ id: "n1", title: "Quadratic equations" }]);
});

test("the study list keeps its text and savedAt", () => {
  const fields = ["text", "savedAt"];
  const tracked = trackChanges({}, ["q1"], {
    now: NOW, fields, payloads: { q1: { text: "Why is the sky blue?", savedAt: 1757577600000 } },
  });
  assert.deepEqual(trackedRecords(tracked, { now: NOW, fields }),
    [{ id: "q1", text: "Why is the sky blue?", savedAt: 1757577600000 }]);
});

test("a tracked set is capped, and live entries outlive tombstones", () => {
  const map = {};
  for (let i = 0; i < MAX_TRACKED; i++) map[`live-${i}`] = { at: ago(DAY) };
  for (let i = 0; i < 20; i++) map[`dead-${i}`] = { at: NOW, d: 1 };
  const capped = trackedModel(map, { now: NOW });
  assert.equal(Object.keys(capped).length, MAX_TRACKED);
  // Dropping a tombstone risks resurrecting one item; dropping a live entry
  // deletes something the user can see. Tombstones go first.
  assert.equal(trackedIds(capped, { now: NOW }).length, MAX_TRACKED);
});

test("junk in a tracked map never reaches the merge", () => {
  assert.deepEqual(trackedModel({ "": { at: 1 }, a: null, b: { at: 0 }, c: "x" }, { now: NOW }), {});
  assert.deepEqual(trackedModel(null, { now: NOW }), {});
  assert.deepEqual(trackedModel([1, 2], { now: NOW }), {});
});

// --- the whole document ----------------------------------------------------

test("a full merge keeps every section's own rule", () => {
  const phone = {
    studyActivity: ["2026-09-10"],
    noteProgress: { n: { opened: 5, lastOpened: "2026-09-10" } },
    pinned: { a1: { at: ago(DAY) } },
    kbSettings: { tutorEffort: "hard", tutorEnabled: true },
  };
  const laptop = {
    studyActivity: ["2026-09-11"],
    noteProgress: { n: { opened: 2, lastOpened: "2026-09-11" } },
    pinned: { a2: { at: ago(DAY) } },
    kbSettings: { tutorEffort: "quick", tutorEnabled: false },
  };
  const merged = mergeSyncedPrefs(phone, laptop, { now: NOW });
  assert.deepEqual(merged.studyActivity, ["2026-09-10", "2026-09-11"]);
  assert.deepEqual(merged.noteProgress, { n: { opened: 5, lastOpened: "2026-09-11" } });
  assert.deepEqual(trackedIds(merged.pinned, { now: NOW }).sort(), ["a1", "a2"]);
  // Settings are the deliberate kind: the asking device's copy stands whole,
  // so "I turned the tutor off here" is not half-applied.
  assert.deepEqual(merged.kbSettings, { tutorEffort: "hard", tutorEnabled: true });
});

test("an empty document on either side is not a reason to lose the other", () => {
  const stored = {
    studyActivity: ["2026-09-10"],
    noteProgress: { n: { opened: 1 } },
    pinned: { a1: { at: ago(DAY) } },
    display: { showSubmitted: true },
  };
  const merged = mergeSyncedPrefs({}, stored, { now: NOW });
  assert.deepEqual(merged.studyActivity, ["2026-09-10"]);
  assert.deepEqual(merged.noteProgress, { n: { opened: 1 } });
  assert.deepEqual(trackedIds(merged.pinned, { now: NOW }), ["a1"]);
  assert.deepEqual(merged.display, { showSubmitted: true });
  // And a first sync from a device with nothing stored yet.
  assert.deepEqual(mergeSyncedPrefs(null, null, { now: NOW }).studyActivity, []);
});

test("a full merge is idempotent — syncing twice changes nothing", () => {
  const a = {
    studyActivity: ["2026-09-10"],
    noteProgress: { n: { opened: 2, lastOpened: "2026-09-10" } },
    pinned: { a1: { at: ago(DAY) }, gone: { at: ago(DAY), d: 1 } },
    studyList: { q1: { at: ago(DAY), text: "why", savedAt: 5 } },
  };
  const b = { studyActivity: ["2026-09-11"], pinned: { a2: { at: ago(DAY) } } };
  const once = mergeSyncedPrefs(a, b, { now: NOW });
  const twice = mergeSyncedPrefs(once, b, { now: NOW });
  assert.deepEqual(twice, once);
  // And the order the two devices reach the server in does not matter.
  const swapped = mergeSyncedPrefs(b, a, { now: NOW });
  assert.deepEqual(swapped.studyActivity, once.studyActivity);
  assert.deepEqual(trackedIds(swapped.pinned, { now: NOW }).sort(),
    trackedIds(once.pinned, { now: NOW }).sort());
});
