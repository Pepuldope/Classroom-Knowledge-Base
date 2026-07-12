// scripts/ai_router_test.mjs — unit tests for the tiered AI router.
//
// Verifies Pepuldo's routing policy without hitting the network:
//   1. quick   task -> effort-1 (cheap) provider, never strong
//   2. default task -> effort-2 (mid) provider, never strong
//   3. hard    task -> effort-3 (strong) provider
//   4. cheap provider 429s -> escalate one tier up (mid), not strong
//   5. rpm limit on a provider -> fail over (don't retry the throttled one)
//   6. load-balances across same-tier providers across calls
//   7. classify-first routes an ambiguous request to the strong tier when the
//      cheap classifier says "hard"
//
// Uses node:test + node:assert. Stubs global.fetch and enables providers by
// setting their apiKeys directly (the module reads process.env at load, which
// is absent in the test sandbox).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, routeChat } from "../api/ai-router.js";

// Enable all bundled providers (module read process.env at load; stub keys).
for (const p of PROVIDERS) p.apiKey = "test-key";

// Add a second effort-1 provider so the "quick" band has 2 (load-balance test).
const E1 = {
  name: "e1test",
  baseURL: "http://e1.test/v1/chat/completions",
  apiKey: "test-key",
  model: "e1",
  effort: 1,
};
PROVIDERS.push(E1);

const byUrl = new Map(PROVIDERS.map((p) => [p.baseURL, p]));
const effMap = new Map(PROVIDERS.map((p) => [p.name, p.effort || 1]));
const REAL_FETCH = global.fetch;

function json(status, obj) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

// scenario: { fail: [providerNames], classifyTier?: "hard"|"quick"|"default" }
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

afterEach(() => { global.fetch = REAL_FETCH; });

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
  installFetch({ fail: ["cerebras", "e1test"] }); // both effort-1 fail -> fallback effort-2
  const r = await routeChat([{ role: "user", content: "tag this" }], { task: "quick" });
  assert.equal(effMap.get(r.provider), 2, `expected escalation to mid, got ${r.provider}`);
});

test("rpm limit on cheap provider forces failover, not retry", async () => {
  const cerebras = PROVIDERS.find((p) => p.name === "cerebras");
  const orig = cerebras.rpmLimit;
  cerebras.rpmLimit = 1; // allow exactly 1/min
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
  assert.match(r.text, /OK-from-/);
});
