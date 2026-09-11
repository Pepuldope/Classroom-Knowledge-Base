// scripts/ai_router_test.mjs — unit tests for the tiered AI router.
//
// Verifies Pepuldo's routing policy + the 5 final checks without network:
//   1. quick   task -> cheap (effort-1) provider, never strong
//   2. default task -> mid (effort-2) provider, never strong
//   3. hard    task -> strong (effort-3) provider
//   4. cheap 429 -> escalate one tier up (mid), not strong
//   5. rpm limit -> fail over, not retry
//   6. load-balances across same-tier providers
//   7. classify-first routes a hard request to strong models
//   8. [CHECK #1] circuit breaker: repeated failures cool down a provider
//   9. [CHECK #2] structured log record carries provider/model/tier/reason/latency/errorType
//  10. [CHECK #3] forced-fail drill: traffic moves to next provider exactly
//  11. [CHECK #4] capability guard: requires:[...] never silently downgrades
//  12. [CHECK #5] metrics counters track selections/fallbacks/byProvider

import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  routeChat,
  forceProviderFail,
  forceProviderDown,
  resetRouterHealth,
  getRouterMetrics,
  recentRoutes,
  __debugSetHealth,
  setDrillDown,
  getDrillState,
  providerModels,
  primaryModel,
  isModelLevelFailure,
  completeChat,
} from "../api/ai-router.js";

// Enable all bundled providers (module read process.env at load; stub keys).
for (const p of PROVIDERS) p.apiKey = "test-key";
if (!PROVIDERS.find((p) => p.name === "e1test")) {
  PROVIDERS.push({ name: "e1test", baseURL: "http://e1.test/v1/chat/completions", apiKey: "test-key", model: "e1", effort: 1, capabilities: ["json"] });
}
const byUrl = new Map(PROVIDERS.map((p) => [p.baseURL, p]));
const effMap = new Map(PROVIDERS.map((p) => [p.name, p.effort || 1]));
const REAL_FETCH = global.fetch;

function json(status, obj) {
  return { status, ok: status >= 200 && status < 300, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function installFetch(scenario = {}) {
  global.fetch = async (url, init) => {
    const p = byUrl.get(url);
    const name = p?.name;
    // The model actually asked for — a provider with a chain sends a different
    // one on each attempt, and that is the whole thing under test below.
    let model = null;
    try { model = JSON.parse(init?.body || "{}").model || null; } catch {}
    if (scenario.onRequest) scenario.onRequest(name, model);
    if (scenario.classifyTier && name === "cerebras") {
      return json(200, { choices: [{ message: { content: `{"tier":"${scenario.classifyTier}"}` } }] });
    }
    if (scenario.deadModels?.[model]) {
      const dead = scenario.deadModels[model];
      return { status: dead.status, ok: false, json: async () => ({}), text: async () => dead.body };
    }
    if (scenario.fail && scenario.fail.includes(name)) return json(429, { error: "rate" });
    return json(200, { choices: [{ message: { content: `OK-from-${name}:${model}` } }] });
  };
}
beforeEach(() => resetRouterHealth());
afterEach(() => {
  global.fetch = REAL_FETCH;
  resetRouterHealth();
  for (const p of PROVIDERS) forceProviderFail(p.name, false);
});

test("quick task uses an effort-1 (cheap) provider, never strong", async () => {
  installFetch();
  const r = await routeChat([{ role: "user", content: "summarize this" }], { task: "quick" });
  assert.ok(["cerebras", "e1test"].includes(r.provider), `got ${r.provider}`);
  assert.equal(effMap.get(r.provider), 1);
});

test("default task uses a mid (effort-2) provider, never strong", async () => {
  installFetch();
  const r = await routeChat([{ role: "user", content: "explain photosynthesis" }], { task: "default" });
  assert.equal(effMap.get(r.provider), 2, `expected mid tier, got ${r.provider}`);
});

test("hard task uses a strong (effort-3) provider", async () => {
  installFetch();
  const r = await routeChat([{ role: "user", content: "plan a multi-week architecture" }], { task: "hard" });
  assert.equal(effMap.get(r.provider), 3, `expected strong tier, got ${r.provider}`);
});

test("quick task escalates to mid when the cheap provider 429s", async () => {
  installFetch({ fail: ["cerebras", "e1test"] });
  const r = await routeChat([{ role: "user", content: "tag this" }], { task: "quick" });
  assert.equal(effMap.get(r.provider), 2, `expected escalation to mid, got ${r.provider}`);
});

test("rpm limit on cheap provider forces failover, not retry", async () => {
  const cerebras = PROVIDERS.find((p) => p.name === "cerebras");
  const orig = cerebras.rpmLimit;
  cerebras.rpmLimit = 1;
  installFetch();
  const r1 = await routeChat([{ role: "user", content: "x" }], { task: "quick" });
  const r2 = await routeChat([{ role: "user", content: "x" }], { task: "quick" });
  cerebras.rpmLimit = orig;
  assert.notEqual(r1.provider, r2.provider, "second call should not reuse throttled provider");
  assert.ok(["cerebras", "e1test"].includes(r1.provider) && ["cerebras", "e1test"].includes(r2.provider));
});

test("load-balances across effort-1 providers across calls", async () => {
  installFetch();
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const r = await routeChat([{ role: "user", content: "x" }], { task: "quick" });
    seen.add(r.provider);
  }
  assert.ok(seen.has("cerebras") && seen.has("e1test"), `expected both providers used, got ${[...seen]}`);
});

test("classify-first routes a hard request to strong models", async () => {
  installFetch({ classifyTier: "hard" });
  const r = await routeChat([{ role: "user", content: "design a distributed system" }]);
  assert.equal(effMap.get(r.provider), 3, `classify should escalate to strong, got ${r.provider}`);
});

// CHECK #1 — circuit breaker
test("circuit breaker cools down a provider after repeated failures", async () => {
  // Isolate google as the only reachable mid provider so it is attempted
  // repeatedly and fails; the breaker should trip -> OPEN (cooldown).
  for (const n of ["groq", "mistral", "github", "qwen", "freellmapi"]) forceProviderDown(n, true);
  forceProviderFail("google", true); // attempted but throws 429 -> breaker observes it
  installFetch();
  for (let i = 0; i < 5; i++) {
    try { await routeChat([{ role: "user", content: "hi" }], { task: "default" }); } catch {}
  }
  const h = getRouterMetrics().health.find((x) => x.provider === "google");
  assert.ok(h, "google present in health (it was attempted + failed)");
  assert.ok(h.state === "open" || h.cooldownUntil > Date.now(), "google breaker tripped to OPEN / cooldown set");
  assert.ok(h.consecutiveFailures >= 3, "google accumulated >=3 consecutive failures");
});

// CHECK #2 — structured log record
test("structured log record carries provider/model/tier/reason/latency/errorType", async () => {
  forceProviderFail("google", true); // force one error to exercise errorType path
  installFetch();
  for (let i = 0; i < 4; i++) {
    try { await routeChat([{ role: "user", content: "hi" }], { task: "default" }); } catch {}
  }
  const routes = recentRoutes();
  assert.ok(routes.length >= 1, "emitted at least one [router] record");
  const rec = routes[0];
  for (const f of ["ts", "tier", "task", "provider", "model", "reason", "latencyMs", "errorType", "ok"]) {
    assert.ok(f in rec, `log record missing field: ${f}`);
  }
  assert.equal(typeof rec.latencyMs, "number");
  assert.ok(routes.some((r) => r.errorType === "rate_limited"), "an error record carries errorType");
});

// CHECK #3 — forced-fail drill
test("forced-fail drill: a failing provider is attempted then traffic fails over", async () => {
  // forceProviderFail => google is attempted but throws 429; the router must
  // record it as tried and fall back to the next provider.
  forceProviderFail("google", true); // simulate google 429ing
  installFetch();
  let googleWasTried = false;
  let sawFallback = false;
  for (let i = 0; i < 8; i++) {
    const r = await routeChat([{ role: "user", content: "hi" }], { task: "default" });
    if (r.meta.tried.includes("google")) googleWasTried = true;
    if (r.meta.attempts > 1) sawFallback = true;
  }
  assert.ok(googleWasTried, "google was attempted (429) and NOT silently skipped");
  assert.ok(sawFallback, "traffic fell back to the next provider after google failed");
});

// CHECK #4 — capability guard
test("capability guard: requires:[...] never silently downgrades", async () => {
  installFetch();
  const r = await routeChat([{ role: "user", content: "use a tool to look this up" }], { task: "quick", requires: ["tools"] });
  assert.equal(effMap.get(r.provider), 2, "escalated to a tools-capable (mid) provider instead of downgrading");
  assert.ok((PROVIDERS.find((p) => p.name === r.provider).capabilities || []).includes("tools"), "chosen provider actually supports tools");
  // A forced-down provider lacking the capability must not be used.
  forceProviderDown("cerebras", true);
  const r2 = await routeChat([{ role: "user", content: "x" }], { task: "default", requires: ["json"] });
  assert.notEqual(r2.provider, "cerebras", "down + incapable provider excluded");
  assert.ok((PROVIDERS.find((p) => p.name === r2.provider).capabilities || []).includes("json"), "chosen provider supports json");
});

// CHECK #5 — metrics
test("metrics track selections, fallbacks, and per-provider counts", async () => {
  forceProviderFail("google", true);
  installFetch();
  const before = getRouterMetrics();
  await routeChat([{ role: "user", content: "hi" }], { task: "default" });
  const after = getRouterMetrics();
  assert.ok(after.selections > before.selections, "selections incremented");
  assert.ok(after.fallbacks >= 1, "fallback recorded when google was forced-fail");
  assert.ok(Object.values(after.byProvider).some((v) => v > 0), "byProvider counters populated");
  assert.ok("fallbackRate" in after, "fallbackRate computed");
});

// NEW: hard task routes to NVIDIA effort-3 + fires a parallel DeepSeek shadow
// (the post-2026-07-12 routing: Nemotron replaces flaky deepseek-v4-flash on
// NVIDIA; DeepSeek-v4-pro stays in the loop as an independent shadow check).
test("hard task uses NVIDIA effort-3 and attaches a parallel DeepSeek shadow", async () => {
  installFetch();
  const r = await routeChat([{ role: "user", content: "audit this app" }], { task: "hard" });
  assert.equal(effMap.get(r.provider), 3, "hard task hits effort-3");
  // Primary must be a real effort-3 provider and must NOT be the old flaky
  // deepseek-v4-flash model. With the mock, rotation can pick nvidia OR
  // openrouter (both effort-3) — both are valid post-fix choices.
  assert.ok(["nvidia", "openrouter"].includes(r.provider), `effort-3 primary is nvidia or openrouter, got ${r.provider}`);
  assert.notEqual(r.model, "deepseek-ai/deepseek-v4-flash", "must NOT route to the flaky deepseek-flash model");
  if (r.provider === "nvidia") {
    assert.equal(r.model, "nvidia/llama-3.3-nemotron-super-49b-v1", "nvidia effort-3 slot is Nemotron, not deepseek-flash");
  }
  assert.ok(r.meta && r.meta.tier === 3, "meta.tier === 3");
  // Shadow is fired in parallel for hard non-stream; it must resolve to a check
  // object (either an ok second opinion or a swallowed ok:false). It must NOT
  // throw and must not be the primary response.
  assert.ok(r.shadow && typeof r.shadow.then === "function", "shadow is a pending promise on the response");
  const s = await r.shadow;
  assert.ok("ok" in s, "shadow resolved with an ok flag");
  assert.ok("model" in s, "shadow reports which model ran");
  // DeepSeek shadow must never be the served text.
  assert.notEqual(r.text, s.text, "shadow text is distinct from primary (it is not the served answer)");
});

// NEW: shadow is skipped when the primary already served via OpenRouter/DeepSeek
// (no double-counting), and for streaming tutor calls (no parallel second-opinion).
test("shadow skipped when primary is openrouter and for streaming calls", async () => {
  // Force everyone except openrouter down so the primary becomes openrouter.
  for (const n of ["nvidia", "google", "groq", "mistral", "cerebras", "github", "qwen", "freellmapi"]) forceProviderDown(n, true);
  installFetch();
  const r = await routeChat([{ role: "user", content: "audit" }], { task: "hard" });
  assert.equal(r.provider, "openrouter", "primary fell through to openrouter");
  const s = await r.shadow;
  assert.equal(s.ok, false, "shadow skipped because primary already served by openrouter");
  // streaming hard call -> no shadow at all
  resetRouterHealth();
  for (const n of ["nvidia", "google", "groq", "mistral", "cerebras", "github", "qwen", "freellmapi", "openrouter"]) forceProviderDown(n, false);
  const r2 = await routeChat([{ role: "user", content: "x" }], { task: "hard", stream: true });
  assert.equal(r2.shadow, null, "streaming hard call has no shadow check");
});

// CHECK #1 (extended) — CONTROLLED half-open recovery
// A tripped breaker must NOT flap straight back into rotation on one success:
// it goes open -> half_open (probe) -> closed only after a successful probe,
// and a failed probe while half_open re-opens it instead of closing.
test("half-open recovery: probe must succeed before closing", async () => {
  // Make google the only mid provider; force it to fail 3x to trip -> OPEN.
  for (const n of ["groq", "mistral", "github", "qwen", "freellmapi"]) forceProviderDown(n, true);
  forceProviderFail("google", true);
  installFetch();
  for (let i = 0; i < 5; i++) {
    try { await routeChat([{ role: "user", content: "hi" }], { task: "default" }); } catch {}
  }
  let h = getRouterMetrics().health.find((x) => x.provider === "google");
  assert.equal(h.state, "open", "breaker should be OPEN after triple failure");

  // Cooldown elapses -> next call moves it to half_open (probe allowed).
  __debugSetHealth("google", { cooldownUntil: Date.now() - 1, state: "open" });
  forceProviderFail("google", false); // probe will now SUCCEED
  await routeChat([{ role: "user", content: "hi" }], { task: "default" });
  h = getRouterMetrics().health.find((x) => x.provider === "google");
  assert.equal(h.state, "closed", "successful probe CLOSES the breaker (threshold=1)");

  // Re-trip, then prove a FAILED probe while half_open re-opens instead of closing.
  for (const n of ["groq", "mistral", "github", "qwen", "freellmapi"]) forceProviderDown(n, true);
  forceProviderFail("google", true);
  for (let i = 0; i < 4; i++) {
    try { await routeChat([{ role: "user", content: "hi" }], { task: "default" }); } catch {}
  }
  __debugSetHealth("google", { cooldownUntil: Date.now() - 1, state: "open" });
  forceProviderFail("google", true); // probe will FAIL again
  try { await routeChat([{ role: "user", content: "hi" }], { task: "default" }); } catch {}
  h = getRouterMetrics().health.find((x) => x.provider === "google");
  assert.equal(h.state, "open", "failed probe while half_open RE-OPENS the breaker");
});

// CHECK #3 (extended) — KV-backed drill state + drill log
// Mirrors the real /api/router-drill flow without network: setDrillDown writes
// to a fake KV (restored into process.env), loadDrillDown reads it back, and
// getDrillState surfaces the append-only drill log.
test("KV-backed drill: setDrillDown marks a provider down and logs it", async () => {
  const store = new Map();
  const fakeKV = {
    url: "http://fakekv",
    token: "tk",
    fetchImpl: async (url, opts) => {
      // parse /set/key/val and /rpush/key/val
      const u = String(url);
      if (u.includes("/set/")) {
        const m = u.match(/set\/([^/]+)\/(.*)$/);
        store.set(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        return { ok: true, json: async () => ({ result: "OK" }) };
      }
      if (u.includes("/rpush/")) {
        const m = u.match(/rpush\/([^/]+)\/(.*)$/);
        const k = decodeURIComponent(m[1]);
        const arr = store.get(k) ? JSON.parse(store.get(k)) : [];
        arr.push(decodeURIComponent(m[2]));
        store.set(k, JSON.stringify(arr));
        return { ok: true, json: async () => ({ result: "OK" }) };
      }
      if (u.includes("/lrange/")) {
        const m = u.match(/lrange\/([^/]+)\//);
        const raw = store.get(decodeURIComponent(m[1])) || "[]";
        let arr = raw;
        if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = []; } }
        return { ok: true, json: async () => ({ result: arr }) };
      }
      if (u.includes("/get/")) {
        const m = u.match(/get\/([^/]+)/);
        const v = store.get(decodeURIComponent(m[1]));
        return { ok: true, json: async () => ({ result: v ?? null }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  };
  const REAL = { url: process.env.KV_REST_API_URL, tok: process.env.KV_REST_API_TOKEN };
  // Point the router's drill KV at our fake by monkeypatching global.fetch
  // for the KV calls (ai-router uses global.fetch with the KV url/token).
  const realFetch = global.fetch;
  global.fetch = (async (url, opts) => {
    const u = String(url);
    if (u.startsWith(fakeKV.url)) return fakeKV.fetchImpl(url, opts);
    return realFetch(url, opts);
  });
  process.env.KV_REST_API_URL = fakeKV.url;
  process.env.KV_REST_API_TOKEN = fakeKV.token;
  try {
    const r1 = await setDrillDown("groq", true);
    assert.ok(r1.ok, "setDrillDown ok");
    assert.ok(r1.forcedDown.includes("groq"), "groq in forcedDown list");
    const st = await getDrillState();
    assert.ok(st.forcedDown.includes("groq"), "drill state reports groq down");
    assert.ok(st.log.length >= 1, "drill log appended an entry");
    const r2 = await setDrillDown("groq", false);
    assert.ok(!r2.forcedDown.includes("groq"), "groq removed when brought back up");
  } finally {
    global.fetch = realFetch;
    process.env.KV_REST_API_URL = REAL.url;
    process.env.KV_REST_API_TOKEN = REAL.tok;
  }
});


// ---------------------------------------------------------------------------
// Model chains — the 2026-09-11 outage.
//
// Production has exactly ONE configured provider (router-health reports
// `configured: false` for the other eight), so "fail over to the next provider"
// had nowhere to go. When `openai/gpt-oss-120b:free` was moved to paid, the
// popup tutor returned a flat 502. The fix is depth WITHIN a provider.
// ---------------------------------------------------------------------------

/**
 * Leave openrouter as the ONLY configured provider, which is what production
 * actually is, and restore the rest afterwards.
 */
function onlyOpenRouter(fn) {
  const saved = PROVIDERS.map((p) => [p, p.apiKey]);
  for (const p of PROVIDERS) if (p.name !== "openrouter") p.apiKey = "";
  return (async () => { try { return await fn(); } finally { for (const [p, key] of saved) p.apiKey = key; } })();
}

const OR = () => PROVIDERS.find((p) => p.name === "openrouter");

test("a retired slug falls through to the next model on the same key", () => onlyOpenRouter(async () => {
  const chain = providerModels(OR());
  const asked = [];
  installFetch({
    onRequest: (name, model) => { if (name === "openrouter") asked.push(model); },
    deadModels: {
      [chain[0]]: {
        status: 404,
        body: '{"error":{"message":"This model is unavailable for free. The paid version is available now","code":404}}',
      },
    },
  });
  const r = await completeChat([{ role: "user", content: "hi" }], { task: "hard" });
  // The exact failure Pepuldo hit: model one is gone, and the answer still
  // arrives — from model two, on the same key, with no user-visible error.
  assert.deepEqual(asked.slice(0, 2), [chain[0], chain[1]]);
  assert.equal(r.model, chain[1], "the answer was not attributed to the model that gave it");
  assert.match(r.text, /OK-from-openrouter/);
}));

test("a chain with every model retired reports all of them, not just the last", () => onlyOpenRouter(async () => {
  const chain = providerModels(OR());
  const dead = {};
  for (const m of chain) dead[m] = { status: 404, body: '{"error":{"message":"unavailable for free","code":404}}' };
  installFetch({ deadModels: dead });
  const err = await completeChat([{ role: "user", content: "hi" }], { task: "hard" }).then(() => null, (e) => e);
  assert.ok(err, "an entirely dead chain still answered");
  // The 502 that started this named one slug and hid the rest. Whoever reads
  // the next one should be able to see the whole chain is gone.
  for (const model of chain) assert.match(err.message, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}));

test("a dead key is not retried against four more models", () => onlyOpenRouter(async () => {
  // The counterpart rule. Walking the chain on a 401 is four more ways to be
  // slow about the same failure.
  const asked = [];
  const dead = {};
  for (const m of providerModels(OR())) dead[m] = { status: 401, body: '{"error":"invalid key"}' };
  installFetch({ onRequest: (name, model) => { if (name === "openrouter") asked.push(model); }, deadModels: dead });
  await completeChat([{ role: "user", content: "hi" }], { task: "hard" }).catch(() => null);
  assert.equal(asked.length, 1, `a 401 tried ${asked.length} models; it should stop at the first`);
}));

test("model-level failures are told apart from provider-level ones", () => {
  // A retired or paid-only slug: try the next model.
  assert.equal(isModelLevelFailure(404, "no endpoints found"), true);
  assert.equal(isModelLevelFailure(404, "This model is unavailable for free. The paid version is available now"), true);
  assert.equal(isModelLevelFailure(400, "model not found"), true);
  // A per-model upstream limit: try the next model. An account-wide one: do not.
  assert.equal(isModelLevelFailure(429, "temporarily rate-limited upstream"), true);
  assert.equal(isModelLevelFailure(429, "Provider returned error"), true);
  assert.equal(isModelLevelFailure(429, "You have exceeded your daily quota"), false);
  // The key and the service are never the model's fault.
  assert.equal(isModelLevelFailure(401, "invalid key"), false);
  assert.equal(isModelLevelFailure(500, "upstream"), false);
  assert.equal(isModelLevelFailure(200, ""), false);
});

test("every provider resolves to at least one model, chain or not", () => {
  for (const p of PROVIDERS) {
    const chain = providerModels(p);
    assert.ok(chain.length >= 1, `${p.name} resolves to no model at all`);
    assert.equal(primaryModel(p), chain[0]);
    assert.ok(chain.every((m) => typeof m === "string" && m.length), `${p.name} has an empty model id`);
  }
  // The one provider that actually carries production has real depth.
  const or = PROVIDERS.find((p) => p.name === "openrouter");
  assert.ok(providerModels(or).length >= 3,
    "openrouter is the only configured provider in production; a short chain is an outage waiting for a retirement");
});
