import test from "node:test";
import assert from "node:assert/strict";

// A throwaway 32-byte key. The module reads TOKEN_ENC_KEY at call time, not at
// import time, so setting it here is enough.
process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64url");

const {
  sealToken, openToken, readCookie, buildSetCookie, buildClearCookie,
  tokenCookieConfigured, REFRESH_COOKIE,
} = await import("../api/_token-cookie.js");

const req = (cookieHeader) => new Request("https://x.test/api/oauth-refresh", {
  headers: cookieHeader ? { cookie: cookieHeader } : {},
});

test("a sealed token round-trips", async () => {
  const token = "1//0gRefreshTokenValue-with_symbols.and~stuff";
  assert.equal(await openToken(await sealToken(token)), token);
});

test("sealing is non-deterministic but still opens", async () => {
  const a = await sealToken("same");
  const b = await sealToken("same");
  assert.notEqual(a, b, "a fresh IV per seal must change the ciphertext");
  assert.equal(await openToken(a), "same");
  assert.equal(await openToken(b), "same");
});

test("sealed output is cookie-safe", async () => {
  const sealed = await sealToken("tok");
  assert.match(sealed, /^[A-Za-z0-9_-]+$/, "must not contain ; , = or whitespace");
});

test("openToken returns null rather than throwing on bad input", async () => {
  for (const bad of ["", null, undefined, "not-base64!!", "aaaa", "A".repeat(40)]) {
    assert.equal(await openToken(bad), null);
  }
});

test("a tampered ciphertext does not open", async () => {
  const sealed = await sealToken("secret-token");
  const flipped = sealed.slice(0, -1) + (sealed.at(-1) === "A" ? "B" : "A");
  assert.equal(await openToken(flipped), null);
});

test("a token sealed under a different key does not open", async () => {
  const sealed = await sealToken("secret-token");
  const original = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString("base64url");
  try {
    assert.equal(await openToken(sealed), null);
  } finally {
    process.env.TOKEN_ENC_KEY = original;
  }
});

test("readCookie finds the refresh cookie among others", () => {
  assert.equal(readCookie(req(`a=1; ${REFRESH_COOKIE}=xyz; b=2`)), "xyz");
  assert.equal(readCookie(req(`${REFRESH_COOKIE}=xyz`)), "xyz");
});

test("readCookie does not match a cookie whose name merely ends the same", () => {
  assert.equal(readCookie(req(`not_${REFRESH_COOKIE}=nope`)), "");
});

test("readCookie returns empty when absent", () => {
  assert.equal(readCookie(req("a=1")), "");
  assert.equal(readCookie(req()), "");
});

test("the set cookie carries every protective attribute", () => {
  const cookie = buildSetCookie("sealed-value");
  assert.match(cookie, /^cwa_rt=sealed-value;/);
  assert.match(cookie, /HttpOnly/, "page scripts must not be able to read it");
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api/, "only the endpoints that need it should receive it");
  assert.match(cookie, /Max-Age=\d+/);
});

test("the clear cookie expires immediately and keeps the same path", () => {
  const cookie = buildClearCookie();
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /Path=\/api/, "a mismatched path would leave the cookie in place");
});

test("tokenCookieConfigured needs both the secret and the key", () => {
  const key = process.env.TOKEN_ENC_KEY;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  try {
    process.env.GOOGLE_CLIENT_SECRET = "s3cret";
    assert.equal(tokenCookieConfigured(), true);
    delete process.env.GOOGLE_CLIENT_SECRET;
    assert.equal(tokenCookieConfigured(), false, "secret alone missing");
    process.env.GOOGLE_CLIENT_SECRET = "s3cret";
    delete process.env.TOKEN_ENC_KEY;
    assert.equal(tokenCookieConfigured(), false, "key alone missing");
  } finally {
    process.env.TOKEN_ENC_KEY = key;
    if (secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = secret;
  }
});

test("a wrong-length key is rejected instead of silently truncated", async () => {
  const key = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = Buffer.alloc(16, 1).toString("base64url");
  try {
    await assert.rejects(() => sealToken("tok"), /32 bytes/);
  } finally {
    process.env.TOKEN_ENC_KEY = key;
  }
});
