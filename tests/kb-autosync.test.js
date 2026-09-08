import test from "node:test";
import assert from "node:assert/strict";
import {
  kbAutoSyncModel, kbSyncStatusModel,
  AUTO_SYNC_AFTER_HOURS, MANUAL_SYNC_AFTER_DAYS, RETRY_AFTER_MINUTES,
} from "../kb-autosync.js";

const NOW = Date.parse("2026-09-08T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();
const daysAgo = (d) => hoursAgo(d * 24);
const base = { hasCorpus: true, signedIn: true, online: true, now: NOW };

test("a corpus that does not exist yet is a manual build", () => {
  // The first build reads every course and every year. That is worth watching.
  assert.deepEqual(kbAutoSyncModel({ hasCorpus: false }), { action: "manual", reason: "no-corpus" });
  assert.equal(kbAutoSyncModel({ ...base, lastSyncAt: null }).action, "manual");
  assert.equal(kbAutoSyncModel({ ...base, lastSyncAt: "not a date" }).reason, "never-synced");
});

test("a recently synced corpus is left alone", () => {
  assert.equal(kbAutoSyncModel({ ...base, lastSyncAt: hoursAgo(0.5) }).reason, "fresh");
  assert.equal(kbAutoSyncModel({ ...base, lastSyncAt: hoursAgo(AUTO_SYNC_AFTER_HOURS - 0.1) }).action, "none");
});

test("a day-old corpus tops itself up in the background", () => {
  assert.deepEqual(kbAutoSyncModel({ ...base, lastSyncAt: hoursAgo(AUTO_SYNC_AFTER_HOURS + 0.1) }),
    { action: "background", reason: "due" });
  assert.equal(kbAutoSyncModel({ ...base, lastSyncAt: daysAgo(1) }).action, "background");
  assert.equal(kbAutoSyncModel({ ...base, lastSyncAt: daysAgo(20) }).action, "background");
});

test("a corpus left for a whole term asks first", () => {
  // Past a month this is not a top-up; it is the long build again, and doing
  // that silently on a phone is not a decision to make for someone.
  assert.deepEqual(kbAutoSyncModel({ ...base, lastSyncAt: daysAgo(MANUAL_SYNC_AFTER_DAYS + 1) }),
    { action: "manual", reason: "stale" });
});

test("nothing happens when there is no point trying", () => {
  const due = { ...base, lastSyncAt: daysAgo(1) };
  assert.equal(kbAutoSyncModel({ ...due, online: false }).reason, "offline");
  assert.equal(kbAutoSyncModel({ ...due, signedIn: false }).reason, "signed-out");
  assert.equal(kbAutoSyncModel({ ...due, buildInFlight: true }).reason, "build-in-flight");
  // ...but an absent corpus still reports "manual" so the UI can offer it.
  assert.equal(kbAutoSyncModel({ hasCorpus: false, online: false }).action, "manual");
});

test("a failed attempt backs off instead of retrying on every page load", () => {
  const due = { ...base, lastSyncAt: daysAgo(1) };
  assert.equal(kbAutoSyncModel({ ...due, lastAttemptAt: hoursAgo(0.1) }).reason, "backoff");
  assert.equal(kbAutoSyncModel({ ...due, lastAttemptAt: new Date(NOW - RETRY_AFTER_MINUTES * 60_000 - 1).toISOString() }).action, "background");
  // A future attempt timestamp is nonsense and must not block forever.
  assert.equal(kbAutoSyncModel({ ...due, lastAttemptAt: hoursAgo(-5) }).action, "background");
});

test("a clock that moved backwards neither syncs nor spins", () => {
  assert.deepEqual(kbAutoSyncModel({ ...base, lastSyncAt: hoursAgo(-3) }), { action: "none", reason: "clock-skew" });
});

test("the stat bar says just enough", () => {
  assert.deepEqual(kbSyncStatusModel("syncing"), { label: "checking…", busy: true });
  assert.deepEqual(kbSyncStatusModel("done", { added: 3 }), { label: "just now · +3", busy: false });
  assert.deepEqual(kbSyncStatusModel("done", { added: 2, removed: 1 }), { label: "just now · +2 · −1", busy: false });
  assert.deepEqual(kbSyncStatusModel("done"), { label: "just now", busy: false });
  assert.deepEqual(kbSyncStatusModel("failed"), { label: "update failed", busy: false });
});
