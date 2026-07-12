// ai-router.js — tiered multi-provider AI router with classify-first,
// circuit breaker, structured logging, capability guards, and live metrics.
//
// Encodes Pepuldo's routing policy:
//   - cheapest model that can do the job; escalate only when needed.
//   - classify-first: when no explicit task is given, a cheap/fast model picks
//     the tier (quick/default/hard) before we spend a stronger one.
//   - load-balance within a tier + fail over to another provider on 429/5xx
//     (never retry the same throttled endpoint).
//   - strong (effort 3) models reserved for hard/risky tasks; routine work
//     never hits them.
//   - circuit breaker: a provider that repeatedly fails (429/5xx/timeout) is
//     marked unhealthy and cooled down for a window instead of being retried
//     aggressively.
//   - capability guard: flows may declare `requires:[...]` (e.g. "tools",
//     "json", "long_context"); the router never silently downgrades a flow to
//     a provider that lacks a required capability.
//
// Edge-safe: only uses the global `fetch` (Web standard) — no node:* imports.
//
// Each provider entry: { name, baseURL, apiKey, model, effort, capabilities?,
//                        extra?, headers?, rpmLimit? }
//   effort (1-3) = capability tier: 1 cheap/free, 2 mid, 3 strong.
//   capabilities = which advanced features this model reliably supports.

export const PROVIDERS = [
  // 1. NVIDIA — Llama-3.3-Nemotron-Super-49B (reliable effort-3 workhorse)
  //    Replaces deepseek-ai/deepseek-v4-flash, which returns 503
  //    "ResourceExhausted: All workers are busy" intermittently on NVIDIA's
  //    free tier (verified ~25% of calls, 7-20s latency) — see investigation
  //    2026-07-12. Nemotron-Super-49B is fast (sub-second) and stable on the
  //    same key, so it's the primary effort-3 slot. DeepSeek-v4-PRO is still
  //    in the loop via OpenRouter (slot 9) as escalation + parallel checker.
  //    HARD LIMIT (per Pepuldo): the whole NVIDIA API key must stay UNDER 48
  //    requests/minute. We enforce a 46/min sliding-window throttle below so the
  //    router skips NVIDIA (and fails over) rather than blowing the key-wide cap.
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1/chat/completions",
    apiKey: process.env.NVIDIA_API_KEY,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    effort: 3,
    capabilities: ["json", "long_context"],
    rpmLimit: 46, // < 48 key-wide ceiling; enforced in routeChat
  },
  // 2. Google Gemini 2.5 Flash (OpenAI-compatible mode, fast + capable)
  {
    name: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKey: process.env.GOOGLE_API_KEY,
    model: "gemini-2.5-flash",
    effort: 2,
    capabilities: ["tools", "json", "long_context"],
    extra: { thinkingBudget: 0 }, // long answers shouldn't be truncated
  },
  // 3. Groq — very fast, good for quick tutor turns
  {
    name: "groq",
    baseURL: (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1") + "/chat/completions",
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile",
    effort: 2,
    capabilities: ["tools", "json"],
  },
  // 4. Mistral Large
  {
    name: "mistral",
    baseURL: (process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1") + "/chat/completions",
    apiKey: process.env.MISTRAL_API_KEY,
    model: "mistral-large-latest",
    effort: 2,
    capabilities: ["tools", "json"],
  },
  // 5. Cerebras — fast inference
  {
    name: "cerebras",
    baseURL: (process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1") + "/chat/completions",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama3.1-70b",
    effort: 1,
    capabilities: ["json"],
  },
  // 6. GitHub Models (GPT-4o-mini)
  {
    name: "github",
    baseURL: (process.env.GITHUB_BASE_URL || "https://models.inference.ai.azure.com") + "/chat/completions",
    apiKey: process.env.GITHUB_API_KEY,
    model: "gpt-4o-mini",
    effort: 2,
    capabilities: ["tools", "json"],
  },
  // 7. Qwen Max
  {
    name: "qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    apiKey: process.env.QWEN_API_KEY,
    model: "qwen-max",
    effort: 2,
    capabilities: ["json", "long_context"],
  },
  // 8. Local FreeLLMAPI proxy — never rate-limited, many models via "auto"
  {
    name: "freellmapi",
    baseURL: (process.env.FREELLMAPI_BASE_URL || "http://127.0.0.1:3001") + "/v1/chat/completions",
    apiKey: process.env.FREELLMAPI_API_KEY,
    model: "auto",
    effort: 2,
    capabilities: ["json"], // tool-use depends on the proxied model; don't assume.
  },
  // 9. OpenRouter — DeepSeek v4 Pro for very-high-intelligence tasks (NVIDIA hosted pro throttles/hangs on free tier, so route via OpenRouter);
  //    not the default (so we don't lean on a single provider / weak model).
  {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "deepseek/deepseek-v4-pro",
    effort: 3,
    capabilities: ["json", "long_context"],
    headers: { "HTTP-Referer": "https://classroom-knowledge-base.vercel.app", "X-Title": "Classroom KB" },
  },
];

function enabledProviders() {
  return PROVIDERS.filter((p) => p.apiKey && p.baseURL);
}

// ---------------------------------------------------------------------------
// Circuit breaker / health (check #1) — with CONTROLLED half-open recovery
// State machine per provider:
//   closed    : normal. On `failureThreshold` consecutive OR cumulative
//               failures in the rolling window -> OPEN (cooldown).
//   open      : not selected for `cooldownMs`. After cooldown, transitions to
//               half-open (one chance to probe).
//   half-open : a LIMITED number of probe requests are allowed through
//               (halfOpenProbes). A probe success (halfOpenSuccessThreshold
//               successes) -> CLOSED (recovered, fully back in rotation).
//               A probe failure -> back to OPEN (re-cooldown). This prevents a
//               recovered provider from immediately flapping back into failure.
// Unhealthy providers are excluded from selection so we stop hammering them.
// If EVERY provider is unhealthy we fail open (use all) so we still attempt.
// Drill overrides (live failover proof, check #3): in-memory `forceProviderDown`
// (unit tests) or the KV-backed `_activeDrill` set (set via /api/router-drill)
// make a provider look down without touching its real health.
// ---------------------------------------------------------------------------
const BREAKER = {
  cooldownMs: 60_000, // how long a tripped breaker stays OPEN
  failureThreshold: 3, // consecutive failures to OPEN the breaker
  healthyRate: 0.5, // success-ratio floor over the recent window
  recentMax: 20, // size of the rolling outcome window
  halfOpenProbes: 2, // max simultaneous probe attempts while HALF-OPEN
  halfOpenSuccessThreshold: 1, // probe successes needed to fully CLOSE
};
const _health = new Map(); // name -> { state, consecutiveFailures, cooldownUntil, halfOpenInflight, halfOpenSuccesses, outcomes:[] }
function getHealth(name) {
  let h = _health.get(name);
  if (!h) {
    h = { state: "closed", consecutiveFailures: 0, cooldownUntil: 0, halfOpenInflight: 0, halfOpenSuccesses: 0, outcomes: [] };
    _health.set(name, h);
  }
  return h;
}

// ---- Drill / forced-down state (live failover proof, check #3) ----
// Two sources: (a) in-memory `forceProviderDown` used by unit tests + the
// `forceProviderFail` synthetic-429 set; (b) KV-backed `_activeDrill`, read
// (cached 10s) so a drill triggered via /api/router-drill survives across
// serverless instances. `routeChat` refreshes `_activeDrill` per call.
const _forcedFail = new Set();
const _drillCache = { set: new Set(), at: 0 };
let _activeDrill = new Set(); // set per-request at the top of routeChat
async function loadDrillDown() {
  const now = Date.now();
  if (now - _drillCache.at < 10_000) return _drillCache.set;
  const next = new Set();
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  if (url && tok) {
    try {
      const r = await fetch(`${url}/get/${encodeURIComponent("router:forcedDown")}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (r.ok) {
        const d = await r.json();
        let arr = d.result;
        if (typeof arr === "string") {
          try { arr = JSON.parse(arr); } catch { arr = null; }
        }
        if (Array.isArray(arr)) for (const n of arr) next.add(n);
      }
    } catch {}
  }
  _drillCache.set = next;
  _drillCache.at = now;
  return next;
}
export async function setDrillDown(provider, down) {
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  if (!url || !tok) return { ok: false, error: "KV not configured" };
  const cur = await loadDrillDown();
  if (down) cur.add(provider); else cur.delete(provider);
  const arr = [...cur];
  try {
    await fetch(`${url}/set/${encodeURIComponent("router:forcedDown")}/${encodeURIComponent(JSON.stringify(arr))}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const entry = JSON.stringify({ ts: new Date().toISOString(), provider, down });
    await fetch(`${url}/rpush/${encodeURIComponent("router:drillLog")}/${encodeURIComponent(entry)}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    await fetch(`${url}/expire/${encodeURIComponent("router:drillLog")}/86400`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  _drillCache.at = 0; // force refresh on next read
  return { ok: true, forcedDown: arr };
}
export async function getDrillState() {
  const set = await loadDrillDown();
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  let log = [];
  if (url && tok) {
    try {
      const r = await fetch(`${url}/lrange/${encodeURIComponent("router:drillLog")}/0/50`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (r.ok) {
        const d = await r.json();
        log = Array.isArray(d.result) ? d.result : [];
      }
    } catch {}
  }
  return { forcedDown: [...set], log };
}
export function forceProviderFail(name, on = true) {
  if (on) _forcedFail.add(name);
  else _forcedFail.delete(name);
}
export function forceProviderDown(name, down = true) {
  const p = PROVIDERS.find((x) => x.name === name);
  if (p) p._forcedDown = down;
}
export function resetRouterHealth() {
  _health.clear();
  _forcedFail.clear();
  _drillCache.set = new Set();
  _drillCache.at = 0;
  _activeDrill = new Set();
  for (const p of PROVIDERS) p._forcedDown = false;
}
// Test-only: force a provider's breaker into a specific state.
export function __debugSetHealth(name, patch) {
  Object.assign(getHealth(name), patch);
}

function isForcedDown(p) {
  // Only true pre-exclusion (don't even attempt this provider): a hard admin
  // kill-switch (unit tests) or a live KV-backed drill (check #3).
  // NOTE: `forceProviderFail` is intentionally NOT here — that one lets the
  // provider be *attempted* and throws a synthetic 429 inside callProviderOnce,
  // so the breaker can observe the failure and trip (and traffic fails over).
  return p._forcedDown === true || _activeDrill.has(p.name);
}
// Pure eligibility by breaker state (forced/drill checks done by caller).
function breakerAllowed(p) {
  const h = getHealth(p.name);
  if (h.state === "open") {
    if (Date.now() >= h.cooldownUntil) {
      h.state = "half_open"; // cooldown elapsed -> allow a probe
      h.halfOpenInflight = 0;
      h.halfOpenSuccesses = 0;
    } else return false; // still cooling down
  }
  return true; // closed or half_open both eligible for the pool
}
function beginProbe(p) {
  const h = getHealth(p.name);
  if (h.state === "half_open") h.halfOpenInflight++;
}
function recordOutcome(p, ok) {
  const h = getHealth(p.name);
  h.outcomes.push(ok);
  if (h.outcomes.length > BREAKER.recentMax) h.outcomes.shift();
  if (ok) {
    if (h.state === "half_open") {
      // A successful probe: count it; close only after enough successes.
      h.halfOpenInflight = Math.max(0, h.halfOpenInflight - 1);
      h.halfOpenSuccesses++;
      if (h.halfOpenSuccesses >= BREAKER.halfOpenSuccessThreshold) {
        h.state = "closed";
        h.consecutiveFailures = 0;
        h.cooldownUntil = 0;
        h.halfOpenInflight = 0;
        h.halfOpenSuccesses = 0;
      }
    } else {
      h.state = "closed"; // a normal success keeps it healthy
      h.consecutiveFailures = 0;
      h.cooldownUntil = 0;
    }
  } else {
    h.consecutiveFailures++;
    const recent = h.outcomes.slice(-BREAKER.recentMax);
    const recentFailures = recent.filter((x) => x === false).length;
    if (h.state === "half_open") {
      // The recovery probe failed -> the provider is NOT actually healthy.
      // Re-open (re-cooldown) instead of letting it back into rotation.
      h.halfOpenInflight = Math.max(0, h.halfOpenInflight - 1);
      h.state = "open";
      h.cooldownUntil = Date.now() + BREAKER.cooldownMs;
    } else if (h.consecutiveFailures >= BREAKER.failureThreshold || recentFailures >= BREAKER.failureThreshold) {
      h.state = "open";
      h.cooldownUntil = Date.now() + BREAKER.cooldownMs;
    }
  }
}
function selectable(p) {
  if (!p.apiKey || !p.baseURL) return false;
  if (isForcedDown(p)) return false; // drill / admin kill-switch
  return breakerAllowed(p);
}
function isUnhealthy(p) {
  if (isForcedDown(p)) return true;
  const h = getHealth(p.name);
  if (h.state === "open") return true;
  const recent = h.outcomes.slice(-BREAKER.recentMax);
  if (recent.length >= 5 && recent.filter(Boolean).length / recent.length < BREAKER.healthyRate) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Live metrics (check #5) + structured logging (check #2)
// Counters are module-level (reset on cold start, which is fine for a
// "fallback frequency" production canary — pair with the /api/router-health
// endpoint and the [router] console logs).
// ---------------------------------------------------------------------------
const _metrics = {
  selections: 0,
  fallbacks: 0,
  probes: 0,
  errors: 0,
  shadowChecks: 0,
  shadowOk: 0,
  shadowFailures: 0,
  shadowAgreements: 0,
  byProvider: {},
  byTier: {},
  byReason: {},
};
function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function logRoute(entry) {
  // Standardized, machine-readable record of every routing decision.
  const rec = {
    ts: new Date().toISOString(),
    tier: entry.tier,
    task: entry.task,
    provider: entry.provider,
    model: entry.model,
    reason: entry.reason || "ok",
    latencyMs: entry.latencyMs,
    errorType: entry.errorType || null,
    ok: entry.ok !== false,
  };
  // console.error so it never pollutes a returned JSON body; edges surface
  // console.* in function logs, queryable in the Vercel dashboard.
  try {
    console.error("[router]", JSON.stringify(rec));
  } catch {}
  // Bounded ring buffer of recent decisions (last 50) — testable + surfaced
  // by /api/router-health so you can inspect the last routing trail.
  _recentRoutes.push(rec);
  if (_recentRoutes.length > 50) _recentRoutes.shift();
  return rec;
}
const _recentRoutes = [];
export function recentRoutes() {
  return _recentRoutes.slice();
}

export function getRouterMetrics() {
  const health = [..._health.entries()].map(([n, h]) => ({
    provider: n,
    state: h.state, // closed | open | half_open
    unhealthy: isUnhealthy({ name: n }),
    consecutiveFailures: h.consecutiveFailures,
    cooldownUntil: h.cooldownUntil,
    halfOpenInflight: h.halfOpenInflight,
    halfOpenSuccesses: h.halfOpenSuccesses,
    successRatio: h.outcomes.length ? h.outcomes.filter(Boolean).length / h.outcomes.length : 1,
  }));
  const unhealthy = health.filter((h) => h.unhealthy).map((h) => h.provider);
  const fallbackRate = _metrics.selections ? _metrics.fallbacks / _metrics.selections : 0;
  const shadowRate = _metrics.shadowChecks ? _metrics.shadowOk / _metrics.shadowChecks : 0;
  return {
    ..._metrics,
    fallbackRate,
    shadowRate,
    health,
    alert: unhealthy.length > 0 || fallbackRate > 0.2,
    unhealthy,
    recentRoutes: recentRoutes().slice(-10),
  };
}

/**
 * Call a single provider. Throws on 429/401/5xx/network so the caller fails
 * over. Returns { text, provider, model } (or { stream, ... }).
 */
async function callProviderOnce(p, { messages, max_tokens, temperature, stream }) {
  if (_forcedFail.has(p.name)) {
    const e = new Error(`${p.name} forced-fail (drill)`);
    e.provider = p.name;
    e.status = 429;
    throw e;
  }
  const body = {
    model: p.model,
    messages,
    max_tokens,
    temperature,
    stream,
    ...(p.extra || {}),
  };
  const headers = {
    Authorization: `Bearer ${p.apiKey}`,
    "Content-Type": "application/json",
    ...(p.headers || {}),
  };
  const res = await fetch(p.baseURL, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.status === 429 || res.status === 401 || res.status >= 500) {
    const e = new Error(`${p.name} HTTP ${res.status}`);
    e.provider = p.name;
    e.status = res.status;
    throw e;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`${p.name} HTTP ${res.status}: ${t.slice(0, 200)}`);
    e.provider = p.name;
    e.status = res.status;
    throw e;
  }
  if (stream) return { stream: res.body, provider: p.name, model: p.model, response: res };
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content || "", provider: p.name, model: p.model };
}

/**
 * Shadow checker — keeps DeepSeek in the loop as an INDEPENDENT PARALLEL
 * second opinion on hard/effort-3 calls. Nemotron (NVIDIA) is the authoritative
 * answer; DeepSeek-v4-pro (OpenRouter) fires the same request concurrently and
 * never blocks the primary path. Used only as a cross-check / confidence signal
 * + telemetry, NOT as the served answer. Failures are swallowed (it must never
 * degrade the primary response).
 *
 * @param {Array} messages  same messages as the primary call
 * @param {Object} opts     { max_tokens, temperature }
 * @param {string} primaryProvider name of the provider that actually answered
 * @returns {Promise<Object>} { model, text, agreement, ok, error }
 */
export async function shadowCheckDeepSeek(messages, opts, getPrimary) {
  // Only run for effort-3 (hard) calls, and only if OpenRouter/DeepSeek is up
  // and not the one that already served the answer (avoid double-counting).
  const deepseek = PROVIDERS.find((p) => p.name === "openrouter");
  if (!deepseek || !deepseek.apiKey || !deepseek.baseURL) {
    return { ok: false, error: "deepseek/openrouter not configured", model: null, text: null, agreement: null };
  }
  const primary = typeof getPrimary === "function" ? getPrimary() : getPrimary;
  if (primary === "openrouter") {
    return { ok: false, error: "primary already served by openrouter", model: null, text: null, agreement: null };
  }
  if (!underRpmLimit(deepseek)) {
    return { ok: false, error: "openrouter rpm-limited", model: null, text: null, agreement: null };
  }
  bump(_metrics, "shadowChecks");
  try {
    const r = await callProviderOnce(deepseek, {
      messages,
      max_tokens: opts.max_tokens ?? 2000,
      temperature: opts.temperature ?? 0.3,
      stream: false,
    });
    bump(_metrics, "shadowOk");
    return { ok: true, model: r.model, text: r.text || "", agreement: null, provider: "openrouter" };
  } catch (e) {
    bump(_metrics, "shadowFailures");
    return { ok: false, error: e?.message || String(e), model: deepseek.model, text: null, agreement: null };
  }
}

// Cheap lexical agreement signal between two model outputs (0..1). Not a
// semantic judge — just a telemetry hint that both models landed on similar
// substance (shared key tokens). Wrap in try/catch; never throws.
function agreementScore(a, b) {
  try {
    const norm = (s) => new Set((s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
    const A = norm(a), B = norm(b);
    if (A.size === 0 || B.size === 0) return null;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / Math.min(A.size, B.size);
  } catch { return null; }
}

// Classify-first: a cheap/fast model decides the tier before we spend a
// stronger one. Returns "quick" | "default" | "hard"; never throws (falls
// back to "default"). Walks the cheapest providers first.
async function classifyTask(messages) {
  const q = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const prompt = [
    {
      role: "system",
      content:
        'Classify the user request into exactly one tier. Respond ONLY with JSON like {"tier":"quick"}. ' +
        "quick = summarization, extraction, rewriting, translation, tagging, formatting, simple code boilerplate, classification. " +
        "default = normal chat, light coding, short research, routine tool use. " +
        "hard = multi-step reasoning, long-context analysis, important decisions, big code changes, critical factual judgment, or ambiguous/low-confidence requests.",
    },
    { role: "user", content: q.slice(0, 2000) },
  ];
  const all = enabledProviders().slice().sort((a, b) => (a.effort || 1) - (b.effort || 1));
  for (const p of all) {
    if (!selectable(p)) continue;
    if (!underRpmLimit(p)) continue;
    try {
      const r = await callProviderOnce(p, { messages: prompt, max_tokens: 64, temperature: 0, stream: false });
      const m = r.text.match(/"(quick|default|hard)"/) || r.text.match(/(quick|default|hard)/);
      if (m) return m[1];
    } catch {}
  }
  return "default";
}

// Sliding-window request timestamps per provider name, used to enforce rpmLimit.
const _rpmWindows = new Map();
function underRpmLimit(p) {
  if (!p.rpmLimit) return true;
  const now = Date.now();
  const windowMs = 60_000;
  const stamps = (_rpmWindows.get(p.name) || []).filter((t) => now - t < windowMs);
  _rpmWindows.set(p.name, stamps);
  if (stamps.length >= p.rpmLimit) return false; // would exceed cap -> skip
  stamps.push(now);
  return true;
}

/**
 * Route a chat request across providers with tiered selection + failover.
 * @param {Array} messages Chat messages.
 * @param {Object} opts
 *   task: "quick"|"default"|"tutor"|"hard" (tier selector; classify-first if omitted)
 *   effortMin: 1-3 minimum capability tier
 *   classify: boolean (enable classify-first when no task)
 *   requires: string[] capabilities the chosen model MUST support
 *   stream: boolean
 */
export async function routeChat(messages, opts = {}) {
  const {
    max_tokens,
    temperature,
    stream = false,
    task: taskIn,
    effortMin = 1,
    classify = true,
    requires = null,
  } = opts;

  const TASK_PROFILES = {
    hard: { max_tokens: 8000, temperature: 0.3 },
    tutor: { max_tokens: 6000, temperature: 0.5 },
    default: { max_tokens: 4000, temperature: 0.4 },
    quick: { max_tokens: 1500, temperature: 0.7 },
  };

  // --- Tiered routing (Pepuldo policy) ---
  // Cheapest model that can do the job; escalate only if the cheaper tier
  // fails (fallback) or the task is explicitly hard/strong.
  let task = taskIn;
  const TIER = { quick: 1, default: 2, tutor: 2, hard: 3 };
  let tier = TIER[task] ?? 2;
  if (effortMin > tier) tier = effortMin;

  // Classify-first when no explicit task is given (don't trust wording alone;
  // escalate mid-run if the task turns out harder).
  if (!task && classify) {
    try {
      task = await classifyTask(messages);
      tier = TIER[task] ?? 2;
      if (effortMin > tier) tier = effortMin;
    } catch {
      task = "default";
    }
  }

  const profile = TASK_PROFILES[task] || TASK_PROFILES.default;
  const MT = max_tokens ?? profile.max_tokens;
  const TEMP = temperature ?? profile.temperature;

  // Refresh live drill state (KV-backed) so a drill triggered via
  // /api/router-drill affects this request. Cached 10s inside.
  _activeDrill = await loadDrillDown();

  // Main band = selectable providers exactly at the task's tier (cheapest
  // adequate). Fallback = one tier higher (escalation), appended so it's only
  // used when the main band is exhausted (rate-limited / down / 429 / unhealthy).
  const all = enabledProviders();
  const selectableAll = all.filter(selectable);
  const pool = selectableAll.length ? selectableAll : all; // fail open if all unhealthy
  let main = pool.filter((p) => (p.effort || 1) === tier);
  if (main.length === 0) main = pool.filter((p) => (p.effort || 1) >= tier);
  if (main.length === 0) main = pool;
  let fallback = pool.filter((p) => (p.effort || 1) === tier + 1 && !main.includes(p));

  // Capability guard (check #4): never silently downgrade a flow that needs
  // tools / json / long_context. If ANY provider in the pool satisfies the
  // requirement, drop every provider that LACKS it from both bands so we
  // escalate rather than serve a downgraded model.
  if (requires && requires.length) {
    const need = (p) => requires.every((c) => (p.capabilities || []).includes(c));
    if (pool.some(need)) {
      main = main.filter(need);
      fallback = fallback.filter(need);
    }
  }

  // If the main band was emptied (e.g. capability guard), promote the
  // fallback band so we still have somewhere to route.
  if (main.length === 0 && fallback.length) {
    main = fallback;
    fallback = [];
  }

  // Load-balance: rotate the starting provider within the main band so no
  // single endpoint gets hammered.
  const start = main.length ? _rotate % main.length : 0;
  _rotate = (_rotate + 1) % Math.max(1, all.length);
  const ordered = main.length
    ? [...main.slice(start), ...main.slice(0, start), ...fallback]
    : [...fallback];
  if (ordered.length === 0) throw new Error("No AI providers configured");

  bump(_metrics, "selections");
  bump(_metrics.byTier, tier);
  bump(_metrics.byTier, `task:${task}`);

  let lastErr = null;
  const tried = [];
  for (const p of ordered) {
    // Enforce per-provider RPM caps (e.g. NVIDIA <48/min key-wide limit).
    // Skip + fail over rather than burning the key against the ceiling.
    if (!underRpmLimit(p)) {
      lastErr = new Error(`${p.name} skipped: rpmLimit (${p.rpmLimit}/min) reached`);
      bump(_metrics.byReason, "rpm_skip");
      logRoute({ tier, task, provider: p.name, model: p.model, reason: "rpm_skip", latencyMs: 0 });
      continue;
    }
    const pt0 = Date.now();
    const isProbe = getHealth(p.name).state === "half_open";
    if (isProbe) beginProbe(p); // count this as a limited recovery probe
    try {
      const r = await callProviderOnce(p, { messages, max_tokens: MT, temperature: TEMP, stream });
      const latency = Date.now() - pt0;
      recordOutcome(p, true);
      bump(_metrics.byProvider, p.name);
      const reason = tried.length ? `fallback_after:${tried.join(",")}` : (isProbe ? "half_open_probe_ok" : "ok");
      if (tried.length) bump(_metrics, "fallbacks");
      if (isProbe) bump(_metrics, "probes");
      logRoute({ tier, task, provider: p.name, model: p.model, reason, latencyMs: latency });
      // Attach the full routing decision so callers can surface fallback
      // lineage (check #2) without re-deriving it.
      const meta = {
        provider: p.name,
        model: p.model,
        tier,
        task,
        attempts: tried.length + 1,
        tried: tried.slice(),
        fallbackReason: tried.length ? reason : null,
        latencyMs: latency,
      };
      // ---- Parallel DeepSeek shadow check (hard/effort-3 only, non-stream) ----
      // Nemotron (or whichever provider answered) is authoritative; DeepSeek-v4-pro
      // (OpenRouter) runs the SAME request concurrently as an independent second
      // opinion. It never blocks the primary response. Result is attached for
      // telemetry / confidence — not used as the served text.
      let shadow = null;
      if (tier === 3 && !stream) {
        let answered = p.name;
        shadow = shadowCheckDeepSeek(messages, { max_tokens: MT, temperature: TEMP }, () => answered)
          .then((s) => {
            if (s.ok && r.text) {
              const a = agreementScore(r.text, s.text);
              if (a != null) bump(_metrics, "shadowAgreements");
              s.agreement = a;
            }
            return s;
          })
          .catch((e) => ({ ok: false, error: String(e), model: "deepseek-v4-pro", text: null, agreement: null }));
      }
      return { ...r, meta, shadow };
    } catch (e) {
      const latency = Date.now() - pt0;
      recordOutcome(p, false);
      bump(_metrics, "errors");
      const etype =
        e.status === 429 ? "rate_limited" : e.status >= 500 ? "server_error" : e.status === 401 ? "auth_error" : "other";
      bump(_metrics.byReason, etype);
      logRoute({ tier, task, provider: p.name, model: p.model, reason: `error:${etype}`, latencyMs: latency, errorType: etype, ok: false });
      lastErr = e; // 429 / 5xx / network / forced-fail -> try the next provider
      tried.push(p.name);
      continue;
    }
  }
  throw new Error("All AI providers failed: " + (lastErr?.message || "unknown"));
}

/** Non-streaming convenience wrapper. */
export async function completeChat(messages, opts = {}) {
  const r = await routeChat(messages, { ...opts, stream: false });
  return r;
}

let _rotate = 0;
