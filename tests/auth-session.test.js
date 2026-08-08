import test from "node:test";
import assert from "node:assert/strict";
import { tokenRecordModel, authStoragePolicy } from "../auth-session.js";
import revokeHandler from "../api/oauth-revoke.js";

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

test("oauth revoke rejects non-POST requests without contacting Google", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("unexpected network call");
  };
  try {
    const response = await revokeHandler(new Request("https://example.test/api/oauth-revoke", { method: "GET" }));
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { error: "Method not allowed" });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oauth revoke clears the refresh cookie when no browser credential is present", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("unexpected network call");
  };
  try {
    const response = await revokeHandler(new Request("https://example.test/api/oauth-revoke", { method: "POST" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.match(response.headers.get("set-cookie"), /^cwa_rt=; .*Max-Age=0$/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
