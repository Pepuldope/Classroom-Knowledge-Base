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
  global.fetch = async (url) => {
    const p = byUrl.get(url);
    const name = p?.name;
    if (scenario.classifyTier && name === "cerebras") {
      return json(200, { choices: [{ message: { content: `{"tier":"${scenario.classifyTier}"}` } }] });
    }
    if (scenario.fail && scenario.fail.includes(name)) return json(429, { error: "rate" });
    return json(200, { choices: [{ message: { content: `OK-from-${name}` } }] });
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
  // Make google the ONLY reachable mid provider so it is repeatedly attempted
  // and fails; the breaker should trip and cool it down.
  for (const n of ["groq", "mistral", "github", "qwen", "freellmapi"]) forceProviderDown(n, true);
  forceProviderFail("google", true);
  installFetch();
  for (let i = 0; i < 6; i++) {
    try { await routeChat([{ role: "user", content: "hi" }], { task: "default" }); } catch {}
  }
  const h = getRouterMetrics().health.find((x) => x.provider === "google");
  assert.ok(h, "google present in health");
  assert.ok(
    h.consecutiveFailures >= 3 || h.unhealthy || h.cooldownUntil > Date.now(),
    "google breaker tripped / marked unhealthy / cooldown set"
  );
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
test("forced-fail drill: traffic moves to the next provider exactly", async () => {
  forceProviderFail("google", true); // simulate google 429ing
  installFetch();
  let everUsedGoogle = false;
  for (let i = 0; i < 8; i++) {
    const r = await routeChat([{ role: "user", content: "hi" }], { task: "default" });
    if (r.provider === "google") everUsedGoogle = true;
  }
  assert.ok(!everUsedGoogle, "google was forced-fail; must never be selected (traffic moved on)");
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
