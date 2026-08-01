import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthRedirectUrl, parseAuthRedirectHash, randomState } from "../auth-redirect.js";

const BASE = {
  clientId: "client-123.apps.googleusercontent.com",
  scope: "scope.a scope.b",
  redirectUri: "https://example.vercel.app/",
  state: "abc123",
};

test("buildAuthRedirectUrl requests a token response for the given client", () => {
  const url = new URL(buildAuthRedirectUrl(BASE));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), BASE.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), BASE.redirectUri);
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("scope"), BASE.scope);
  assert.equal(url.searchParams.get("state"), "abc123");
  assert.equal(url.searchParams.get("prompt"), "select_account");
});

test("buildAuthRedirectUrl omits login_hint unless one is supplied", () => {
  assert.equal(new URL(buildAuthRedirectUrl(BASE)).searchParams.has("login_hint"), false);
  const hinted = new URL(buildAuthRedirectUrl({ ...BASE, loginHint: "s@school.sk" }));
  assert.equal(hinted.searchParams.get("login_hint"), "s@school.sk");
});

test("parseAuthRedirectHash returns null for an ordinary page load", () => {
  assert.equal(parseAuthRedirectHash("", "abc123"), null);
  assert.equal(parseAuthRedirectHash("#", "abc123"), null);
  assert.equal(parseAuthRedirectHash("#section-2", "abc123"), null);
});

test("parseAuthRedirectHash extracts the token on success", () => {
  const hash = "#access_token=ya29.tok&token_type=Bearer&expires_in=3599&state=abc123";
  assert.deepEqual(parseAuthRedirectHash(hash, "abc123"), { token: "ya29.tok", expiresIn: 3599 });
});

test("parseAuthRedirectHash defaults a missing or bogus expires_in", () => {
  for (const tail of ["", "&expires_in=0", "&expires_in=nonsense"]) {
    const got = parseAuthRedirectHash(`#access_token=t&state=abc123${tail}`, "abc123");
    assert.equal(got.expiresIn, 3600);
  }
});

test("parseAuthRedirectHash rejects a state that does not match", () => {
  const hash = "#access_token=ya29.tok&state=attacker";
  assert.deepEqual(parseAuthRedirectHash(hash, "abc123"), { error: "state_mismatch" });
});

test("parseAuthRedirectHash rejects a token when no state was stored", () => {
  const hash = "#access_token=ya29.tok&state=abc123";
  for (const expected of [null, "", undefined]) {
    assert.deepEqual(parseAuthRedirectHash(hash, expected), { error: "state_mismatch" });
  }
});

test("parseAuthRedirectHash surfaces Google's error, state permitting", () => {
  assert.deepEqual(parseAuthRedirectHash("#error=access_denied&state=abc123", "abc123"), { error: "access_denied" });
  // A mismatched state outranks the reported error — we cannot trust either.
  assert.deepEqual(parseAuthRedirectHash("#error=access_denied&state=x", "abc123"), { error: "state_mismatch" });
});

test("parseAuthRedirectHash reports a state-valid response carrying no token", () => {
  assert.deepEqual(parseAuthRedirectHash("#state=abc123&token_type=Bearer", "abc123"), { error: "no_token" });
});

test("randomState produces distinct 32-char hex values", () => {
  const a = randomState();
  const b = randomState();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});
