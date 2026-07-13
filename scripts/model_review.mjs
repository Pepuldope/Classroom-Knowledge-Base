// scripts/model_review.mjs
// Send the autonomous KB-loop code to 3 models for review, save each critique,
// then have the NVIDIA flash model author a consolidated report.
//
// Reviewers:
//   1. openai/gpt-oss-120b:free  (OpenRouter)  -> high-intelligence critique (FREE; replaces paid deepseek-v4-pro)
//   2. tencent/hy3               (OpenRouter)  -> second opinion
//   3. gemini-2.5-flash          (Google)      -> third opinion
// Report author: nvidia/llama-3.3-nemotron-super-49b-v1 (NVIDIA) -> consolidated summary (FREE/stable; replaces deepseek-v4-flash)
//
// Edge-safe fetch only; reads files from repo root. Usage:
//   node scripts/model_review.mjs            # review the loop, write docs/
//   KB_LIVE_URL=... node scripts/model_review.mjs

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const docsDir = join(ROOT, "docs");
mkdirSync(docsDir, { recursive: true });

const env = process.env;
const REVIEW_FILES = [
  "AGENTS.md",
  "api/kb-store.js",
  "api/ai-router.js",
  "api/kb-scrape.js",
  "archive-builder.js",
  "scripts/seed-vault.mjs",
  "/opt/data/skills/software-development/classroom-kb-dev/SKILL.md",
];

function readOrEmpty(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    // try relative to ROOT
    try {
      return readFileSync(join(ROOT, p), "utf8");
    } catch {
      return `<<could not read ${p}>>`;
    }
  }
}

const bundle = REVIEW_FILES.map((p) => {
  const code = readOrEmpty(p);
  const name = p.includes("/") && p.startsWith("/") ? p.split("/").pop() : p;
  return `\n===== FILE: ${name} =====\n${code}\n===== END ${name} =====`;
}).join("\n");

const REVIEW_PROMPT = `You are a senior software engineer reviewing the autonomous development loop for a Vercel study-tool web app ("Classroom Knowledge Base").

Context:
- This is an autonomous cron loop (runs every 3h) that ingests notes into a shared knowledge base, improves search quality, and occasionally does light UI polish. It must follow AGENTS.md (functional-first, KB != archive).
- The KB is stored in Upstash KV (Vercel Edge, no node:fs). We recently sharded storage (kb:shard:0..N + kb:shards index) to defeat a per-value size limit, and capped note bodies at 1500 chars.
// The AI router now leads with NVIDIA Nemotron-Super-49B and uses OpenRouter
// openai/gpt-oss-120b:free (free) for hard tasks.

Review the following files for: (1) correctness/bugs, (2) Edge-runtime safety (no node:fs/path), (3) KV storage/sharding correctness, (4) autonomous-loop robustness (the loop must not get stuck or do cosmetic work on an empty KB), (5) any security issues (auth, token handling). Be concrete: cite file + line-range, severity (critical/high/med/low), and a fix suggestion. End with a short "VERDICT: SHIP / SHIP-WITH-FIXES / BLOCK" and the top 3 things to address.

${bundle}`;

async function callOpenAICompatible({ baseURL, apiKey, model, system, user, max_tokens = 6000, temperature = 0.3 }) {
  const res = await fetch(baseURL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system || "You are a rigorous code reviewer." },
        { role: "user", content: user },
      ],
      max_tokens,
      temperature,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

const REVIEWERS = [
  {
    key: "gpt-oss-120b",
    label: "GPT-OSS 120B (OpenRouter, free)",
    baseURL: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: env.OPENROUTER_API_KEY,
    model: "openai/gpt-oss-120b:free",
    max_tokens: 8000,
  },
  {
    key: "hy3",
    label: "Tencent Hy3 (OpenRouter)",
    baseURL: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: env.OPENROUTER_API_KEY,
    model: "tencent/hy3",
    max_tokens: 6000,
  },
  {
    key: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash (Google)",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKey: env.GOOGLE_API_KEY,
    model: "gemini-2.5-flash",
    max_tokens: 6000,
  },
];

const REPORT_AUTHOR = {
  key: "flash-report",
  baseURL: "https://integrate.api.nvidia.com/v1/chat/completions",
  apiKey: env.NVIDIA_API_KEY,
  model: "nvidia/llama-3.3-nemotron-super-49b-v1",
  max_tokens: 4000,
};

async function main() {
  const critiques = [];
  for (const r of REVIEWERS) {
    if (!r.apiKey) {
      console.log(`[skip] ${r.label}: no API key`);
      continue;
    }
    console.log(`[review] calling ${r.label} ...`);
    try {
      const text = await callOpenAICompatible({ ...r, user: REVIEW_PROMPT });
      const out = join(docsDir, `model_review_${r.key}.md`);
      writeFileSync(out, `# Code Review — ${r.label}\n\n${text}\n`);
      console.log(`  -> wrote ${out} (${text.length} chars)`);
      critiques.push({ label: r.label, text });
    } catch (e) {
      console.error(`  !! ${r.label} failed: ${e.message}`);
    }
  }

  if (critiques.length === 0) {
    console.error("No reviewer succeeded; cannot write report.");
    process.exit(1);
  }

  // Author consolidated report with NVIDIA flash.
  const combined = critiques.map((c) => `## ${c.label}\n\n${c.text}`).join("\n\n---\n\n");
  const reportPrompt = `You are the lead engineer. Three models reviewed our autonomous KB-loop code. Synthesize their findings into ONE concise engineering report.

Structure:
1. TOP ISSUES (dedupe across reviewers, rank by severity). For each: what, where (file), severity, recommended fix.
2. CONSENSUS vs DISAGREEMENT between reviewers.
3. VERDICT: SHIP / SHIP-WITH-FIXES / BLOCK, with the 3 must-do items.
4. A tight prioritized TODO list.

Keep it actionable and under ~600 words. Do not repeat full critiques verbatim.

${combined}`;

  console.log("[report] authoring consolidated report with NVIDIA Nemotron-Super-49B ...");
  try {
    const report = await callOpenAICompatible({
      ...REPORT_AUTHOR,
      user: reportPrompt,
      max_tokens: REPORT_AUTHOR.max_tokens,
    });
    const out = join(docsDir, "model_review_REPORT.md");
    writeFileSync(out, `# Consolidated Code-Review Report (authored by NVIDIA Llama-3.3-Nemotron-Super-49B)\n\n${report}\n`);
    console.log(`-> wrote ${out}`);
  } catch (e) {
    console.error(`!! report authoring failed: ${e.message}`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
