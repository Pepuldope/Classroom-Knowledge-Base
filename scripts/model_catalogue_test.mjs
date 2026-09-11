// model_catalogue_test.mjs — is every OpenRouter model id in this repo real,
// and still free?
//
// This gate exists because the one before it was too narrow. enrich_models_test
// checked api/enrich.js's chain and nothing else, so on 2026-09-11 it passed
// green while the popup tutor was returning a flat 502: api/ai-router.js named
// `openai/gpt-oss-120b:free`, which OpenRouter had moved to paid, and
// api/ai.js named `minimax/minimax-m2.7:free`, which no longer existed at all.
// A gate that checks one of three lists reports on one of three lists.
//
// Free slugs are retired WITHOUT NOTICE. The failure mode is not an error in
// the code — the code is fine — so nothing but an external check can find it.
//
// Two conditions per id:
//   1. it still exists on OpenRouter;
//   2. it is still $0 in and $0 out. "Available" is not "free", and the way
//      this broke was a model that stayed available and stopped being free.
//
// Network-dependent by nature. No network is "not checked", not "broken":
// exits 0 with a warning so an offline gate does not fail on it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Every file that names OpenRouter ids, and how to find them.
const SOURCES = [
  { file: "api/enrich.js", pattern: /const MODEL_CHAIN = \[([\s\S]*?)\];/ },
  { file: "api/ai.js", pattern: /const MODEL_CHAIN = \[([\s\S]*?)\];/ },
  { file: "api/ai-router.js", pattern: /models: \[([\s\S]*?)\]/ },
];

const found = [];
for (const { file, pattern } of SOURCES) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const block = source.match(pattern);
  assert.ok(block, `no model list found in ${file} — has it been renamed?`);
  const ids = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((id) => id.includes("/"));
  assert.ok(ids.length >= 3, `${file} should keep real depth, found ${ids.length}`);
  for (const id of ids) found.push({ id, file });
}

let catalogue;
try {
  const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `OpenRouter returned HTTP ${response.status}`);
  catalogue = (await response.json()).data;
} catch (error) {
  console.log(`[model catalogue] SKIPPED — could not reach OpenRouter (${error?.name || error}).`);
  console.log("[model catalogue] This is 'not checked', NOT 'the models are fine'.");
  process.exit(0);
}

const byId = new Map(catalogue.map((m) => [m.id, m]));
const isFree = (m) => {
  const p = m.pricing || {};
  return Number(p.prompt || 0) === 0 && Number(p.completion || 0) === 0;
};

const problems = [];
for (const { id, file } of found) {
  const model = byId.get(id);
  if (!model) { problems.push(`${file}: ${id} — no longer exists on OpenRouter`); continue; }
  if (!isFree(model)) { problems.push(`${file}: ${id} — still exists but is no longer free`); continue; }
  console.log(`  ✓ ${id.padEnd(46)} ${String(model.context_length).padStart(8)} ctx  (${file})`);
}

// Depth is the actual protection: a chain of one is an outage waiting for a
// retirement, which is exactly how this broke.
const perFile = new Map();
for (const { id, file } of found) perFile.set(file, (perFile.get(file) || 0) + (byId.has(id) && isFree(byId.get(id)) ? 1 : 0));
for (const [file, live] of perFile) {
  if (live < 2) problems.push(`${file}: only ${live} live free model — one retirement is a total outage`);
}

if (problems.length) {
  console.error(`\n[model catalogue] ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("\nCheck https://openrouter.ai/api/v1/models and replace the dead ids.");
  process.exit(1);
}
console.log(`[model catalogue] ${found.length}/${found.length} ids live and free across ${perFile.size} files.`);
