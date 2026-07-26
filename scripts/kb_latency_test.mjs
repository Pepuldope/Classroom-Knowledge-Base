#!/usr/bin/env node
// Measure cold + warm legacy KB search latency without logging note content.
// Usage: node scripts/kb_latency_test.mjs

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error("latency probe needs at least two samples");
  }
  const values = samples.map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("latency samples must be finite non-negative numbers");
  }
  const warmMs = values.slice(1);
  return {
    coldMs: values[0],
    warmMs,
    warmMaxMs: Math.max(...warmMs),
    warmAverageMs: warmMs.reduce((sum, value) => sum + value, 0) / warmMs.length,
  };
}

async function timedSearch(base, query) {
  const started = performance.now();
  const response = await fetch(`${base}/api/kb-search?q=${encodeURIComponent(query)}&limit=8`);
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`search returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.results) || body.results.length === 0) {
    throw new Error("search returned no results for the probe query");
  }
  if (!Number.isFinite(body.meta?.noteCount) || body.meta.noteCount < 100) {
    throw new Error(`search corpus is unexpectedly small (${body.meta?.noteCount ?? "unknown"})`);
  }
  return { elapsedMs, noteCount: body.meta.noteCount, resultCount: body.results.length };
}

async function main() {
  const base = (process.env.KB_LIVE_URL || "https://classroom-knowledge-google.vercel.app").replace(/\/$/, "");
  const query = process.env.KB_LATENCY_QUERY || "cover letter";
  const budgetMs = Number(process.env.KB_LATENCY_BUDGET_MS || 1000);
  const samples = [];
  let details;
  for (let i = 0; i < 3; i += 1) {
    details = await timedSearch(base, query);
    samples.push(Math.round(details.elapsedMs * 100) / 100);
  }
  const summary = summarizeSamples(samples);
  const report = { base, query, ...summary, noteCount: details.noteCount, resultCount: details.resultCount, budgetMs };
  console.log(JSON.stringify(report, null, 2));
  if (summary.warmMaxMs > budgetMs) {
    console.error(`warm legacy search exceeds ${budgetMs}ms budget`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
