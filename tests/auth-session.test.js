import test from "node:test";
import assert from "node:assert/strict";
import { tokenRecordModel, authStoragePolicy } from "../auth-session.js";

test("token records keep only a bounded token and future expiry", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(
    tokenRecordModel({ token: "access-123", expiresAt: now + 60_000 }, now),
    { token: "access-123", expiresAt: now + 60_000 },
  );
});

test("expired or malformed token records are rejected", () => {
  const now = 1_700_000_000_000;
  assert.equal(tokenRecordModel({ token: "access-123", expiresAt: now }, now), null);
  assert.equal(tokenRecordModel({ token: "", expiresAt: now + 60_000 }, now), null);
  assert.equal(tokenRecordModel({ token: "access-123", expiresAt: "later" }, now), null);
});

test("auth storage policy uses IndexedDB and clears the legacy page-storage key", () => {
  assert.deepEqual(authStoragePolicy(), {
    persistentStore: "IndexedDB",
    legacyTokenKeys: ["cwa_token_v9", "cwa_kb_token"],
    clearLegacyTokenOnRead: true,
    clearLegacyTokenOnSignOut: true,
  });
});
