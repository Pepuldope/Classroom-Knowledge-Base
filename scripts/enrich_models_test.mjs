// enrich_models_test.mjs — is every model in the enrichment chain still real?
//
// Free OpenRouter slugs are retired without notice, and the chain degrades
// silently when one goes: a dead id costs a round-trip and a 404, and the run
// falls through to whatever is left. On 2026-09-09 that was a 2.6B model being
// asked for a JSON object, and the user's only symptom was
// "liquid/lfm-2.5-2.6b:free: empty completion" — an error naming the one link
// that was never going to work, with the three rate-limited ones invisible.
//
// Two conditions, both required:
//   1. the id still exists on OpenRouter;
//   2. it advertises `response_format`, because api/enrich.js sends
//      `provider: { require_parameters: true }` — a model without structured
//      output is not merely worse here, it is unroutable.
//
// Network-dependent by nature. No network is "not checked", not "broken":
// exits 0 with a warning so an offline gate does not fail on it.
//
// Usage: node scripts/enrich_models_test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../api/enrich.js", import.meta.url), "utf8");
const block = source.match(/const MODEL_CHAIN = \[([\s\S]*?)\];/);
assert.ok(block, "MODEL_CHAIN not found in api/enrich.js — has it been renamed?");
const chain = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
assert.ok(chain.length >= 3, `the chain should have real depth, found ${chain.length}`);

let catalogue;
try {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20000),
  });
  assert.ok(response.ok, `OpenRouter returned HTTP ${response.status}`);
  catalogue = (await response.json()).data;
} catch (error) {
  console.log(`[enrich models] SKIPPED — could not reach OpenRouter (${error?.name || error}).`);
  console.log("[enrich models] This is 'not checked', NOT 'the chain is fine'.");
  process.exit(0);
}

const byId = new Map(catalogue.map((model) => [model.id, model]));
const problems = [];
for (const id of chain) {
  const model = byId.get(id);
  if (!model) { problems.push(`${id}: no longer exists on OpenRouter`); continue; }
  const params = model.supported_parameters || [];
  if (!params.includes("response_format")) {
    problems.push(`${id}: does not advertise response_format, so require_parameters cannot route to it`);
  }
}

if (problems.length) {
  console.error("[enrich models] chain has dead links:");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  const usable = catalogue
    .filter((m) => m.id.endsWith(":free") && (m.supported_parameters || []).includes("response_format"))
    .map((m) => m.id)
    .sort();
  console.error(`\n  free models that DO qualify right now:\n    ${usable.join("\n    ")}`);
  process.exit(1);
}

console.log(`[enrich models] ✓ all ${chain.length} chain models exist and support response_format`);
for (const id of chain) console.log(`    ${id}`);
