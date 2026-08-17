import test from "node:test";
import assert from "node:assert/strict";
import { contentFreeTiming } from "../api/kb-route-privacy.js";
import routerHealth from "../api/router-health.js";
import routerDrill from "../api/router-drill.js";
import oauthConfig from "../api/oauth-config.js";

test("legacy timing metadata contains only an allow-listed metric and numeric duration", () => {
  const noteMarker = "Algebra private student note body";
  const header = contentFreeTiming(`kb-search;${noteMarker}`, 42);

  assert.equal(header, "kb-search;dur=42");
  assert.doesNotMatch(header, /Algebra|private|student|body/i);
});

test("legacy timing metadata falls back safely for malformed values", () => {
  assert.equal(contentFreeTiming("kb-related;desc=cache", "not-a-duration"), "kb-related;desc=cache;dur=0");
  assert.equal(contentFreeTiming("note-title-from-error", -10), "kb-route;dur=0");
});

test("router health GET returns JSON metrics without exposing note content", async () => {
  const response = await routerHealth(new Request("https://example.test/api/router-health"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(typeof body.selections, "number");
  assert.equal(typeof body.fallbackRate, "number");
  assert.ok(Array.isArray(body.health));
  assert.ok(Array.isArray(body.unhealthy));
  assert.ok(Array.isArray(body.recentRoutes));
});

test("router health reset clears counters without adding a debug note", async () => {
  const response = await routerHealth(new Request("https://example.test/api/router-health?reset=1"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.selections, 0);
  assert.equal(body.fallbacks, 0);
  assert.equal(body.recentRoutes.length, 0);
  assert.equal(Object.hasOwn(body, "_note"), false);
});

test("router drill rejects unsupported methods with a JSON content type", async () => {
  const response = await routerDrill(new Request("https://example.test/api/router-drill", { method: "PUT" }));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { error: "method not allowed" });
});

test("oauth config disables refresh tokens when either secret is missing", async () => {
  const previousSecret = process.env.GOOGLE_CLIENT_SECRET;
  const previousKey = process.env.TOKEN_ENC_KEY;
  delete process.env.GOOGLE_CLIENT_SECRET;
  process.env.TOKEN_ENC_KEY = "test-key";

  try {
    const response = await oauthConfig();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.hasRefreshTokens, false);
    assert.equal(body.pickerApiKey, null);
  } finally {
    if (previousSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.TOKEN_ENC_KEY;
    else process.env.TOKEN_ENC_KEY = previousKey;
  }
});

test("oauth config enables refresh tokens only when both server secrets exist", async () => {
  const previousSecret = process.env.GOOGLE_CLIENT_SECRET;
  const previousKey = process.env.TOKEN_ENC_KEY;
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.TOKEN_ENC_KEY = "test-key";

  try {
    const response = await oauthConfig();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.hasRefreshTokens, true);
    assert.equal(body.pickerApiKey, null);
  } finally {
    if (previousSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.TOKEN_ENC_KEY;
    else process.env.TOKEN_ENC_KEY = previousKey;
  }
});
test("prefs reports unavailable storage before attempting authentication", async () => {
  const previousUrl = process.env.KV_REST_API_URL;
  const previousToken = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  try {
    const { default: prefs } = await import("../api/prefs.js?test=prefs-storage-unavailable");
    const response = await prefs(new Request("https://example.test/api/prefs"));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(await response.json(), { error: "storage_not_configured" });
  } finally {
    if (previousUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previousToken;
  }
});

test("oauth refresh rejects a request without a refresh cookie", async () => {
  const { default: oauthRefresh } = await import("../api/oauth-refresh.js?test=oauth-refresh-no-cookie");
  const response = await oauthRefresh(new Request("https://example.test/api/oauth-refresh", {
    method: "POST",
  }));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "no_refresh_token" });
  assert.match(response.headers.get("set-cookie") || "", /cwa_rt=.*Max-Age=0/);
});

test("feedback rejects an unauthenticated submission", async () => {
  const { default: feedback } = await import("../api/feedback.js?test=feedback-unauthorized");
  const response = await feedback(new Request("https://example.test/api/feedback", {
    method: "POST",
    body: JSON.stringify({ text: "private feedback" }),
  }));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("chat prune returns unauthorized when user verification cannot reach OAuth", async () => {
  const previousUrl = process.env.KV_REST_API_URL;
  const previousToken = process.env.KV_REST_API_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.KV_REST_API_URL = "https://kv.example";
  process.env.KV_REST_API_TOKEN = "test-kv-token";
  globalThis.fetch = async () => { throw new Error("OAuth unavailable"); };

  try {
    const { default: chatPrune } = await import("../api/chat-prune.js?test=chat-prune-oauth-error");
    const response = await chatPrune(new Request("https://example.test/api/chat-prune", {
      method: "POST",
      headers: { Authorization: "Bearer classroom-token" },
      body: JSON.stringify({ keepIds: [] }),
    }));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previousToken;
  }
});

test("chat prune deletes indexed chats that are not retained", async () => {
  const previousUrl = process.env.KV_REST_API_URL;
  const previousToken = process.env.KV_REST_API_TOKEN;
  const previousFetch = globalThis.fetch;
  const calls = [];
  process.env.KV_REST_API_URL = "https://kv.example";
  process.env.KV_REST_API_TOKEN = "test-kv-token";
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ sub: "student-1" }), { status: 200 });
    }
    if (String(url).includes("/smembers/")) {
      return new Response(JSON.stringify({ result: ["keep", "stale"] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
  };

  try {
    const { default: chatPrune } = await import("../api/chat-prune.js?test=chat-prune");
    const response = await chatPrune(new Request("https://example.test/api/chat-prune", {
      method: "POST",
      headers: { Authorization: "Bearer classroom-token" },
      body: JSON.stringify({ keepIds: ["keep"] }),
    }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(body, { ok: true, deleted: 1 });
    assert.ok(calls.some(({ url }) => url.endsWith("/del/chat%3Astudent-1%3Astale")));
    assert.ok(calls.some(({ url }) => url.endsWith("/srem/chat-index%3Astudent-1/stale")));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previousToken;
  }
});
