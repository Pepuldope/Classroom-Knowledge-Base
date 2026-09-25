import test from "node:test";
import assert from "node:assert/strict";
import {
  driveTokenRequestOptions, driveTokenExpiry, readCachedDriveToken,
  writeCachedDriveToken, clearCachedDriveToken, DRIVE_TOKEN_KEY,
} from "../drive-token.js";

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test("the Drive request names the remembered account and only prompts when needed", () => {
  assert.deepEqual(driveTokenRequestOptions("peter@school.sk"), { prompt: "", hint: "peter@school.sk" });
});

test("with no remembered account it still avoids forcing the chooser", () => {
  assert.deepEqual(driveTokenRequestOptions(""), { prompt: "" });
  assert.deepEqual(driveTokenRequestOptions(undefined), { prompt: "" });
});

test("expiry keeps a 60s safety margin and defaults to an hour", () => {
  assert.equal(driveTokenExpiry(3600, 1000), 1000 + 3540 * 1000);
  assert.equal(driveTokenExpiry(undefined, 0), 3540 * 1000);
  assert.equal(driveTokenExpiry(30, 0), 0);
});

test("a cached token is reused until it expires", () => {
  const s = memoryStorage();
  writeCachedDriveToken(s, "tok", 5000);
  assert.deepEqual(readCachedDriveToken(s, 4999), { token: "tok", expiry: 5000 });
  assert.equal(readCachedDriveToken(s, 5000), null);
});

test("clearing drops it, and junk or a missing storage never throws", () => {
  const s = memoryStorage();
  writeCachedDriveToken(s, "tok", 5000);
  clearCachedDriveToken(s);
  assert.equal(readCachedDriveToken(s, 0), null);
  s.setItem(DRIVE_TOKEN_KEY, "{not json");
  assert.equal(readCachedDriveToken(s, 0), null);
  assert.equal(readCachedDriveToken(null, 0), null);
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readCachedDriveToken(throwing, 0), null);
  writeCachedDriveToken(throwing, "t", 1);
  clearCachedDriveToken(throwing);
});
