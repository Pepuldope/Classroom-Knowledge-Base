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
  // 1. NVIDIA — DeepSeek v4 Flash (strong, fast, reliable free tier; default workhorse)
  //    HARD LIMIT (per Pepuldo): the whole NVIDIA API key must stay UNDER 48
  //    requests/minute. We enforce a 46/min sliding-window throttle below so the
  //    router skips NVIDIA (and fails over) rather than blowing the key-wide cap.
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1/chat/completions",
    apiKey: process.env.NVIDIA_API_KEY,
    model: "deepseek-ai/deepseek-v4-flash",
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
// Circuit breaker / health (check #1)
// A provider is "unhealthy" if:
//   - it has hit `failureThreshold` consecutive failures (trips the breaker ->
//     cooled down for `cooldownMs`), OR
//   - its recent success ratio over the rolling window is below `healthyRate`.
// Unhealthy providers are excluded from selection so we stop hammering them.
// If EVERY provider is unhealthy we fail open (use all) so we still attempt.
// ---------------------------------------------------------------------------
const BREAKER = {
  cooldownMs: 60_000, // 1 minute cooldown after tripping
  failureThreshold: 3, // consecutive failures to open the breaker
  healthyRate: 0.5, // success ratio floor over the recent window
  recentMax: 20, // size of the rolling outcome window
};
const _health = new Map(); // name -> { consecutiveFailures, cooldownUntil, outcomes:[] }
function getHealth(name) {
  let h = _health.get(name);
  if (!h) {
    h = { consecutiveFailures: 0, cooldownUntil: 0, outcomes: [] };
    _health.set(name, h);
  }
  return h;
}
function isUnhealthy(p) {
  if (p._forcedDown) return true; // live drill / admin kill-switch
  const h = getHealth(p.name);
  if (h.cooldownUntil > Date.now()) return true; // breaker open
  const recent = h.outcomes.slice(-BREAKER.recentMax);
  if (recent.length >= 5) {
    const ok = recent.filter(Boolean).length;
    if (ok / recent.length < BREAKER.healthyRate) return true;
  }
  return false;
}
function recordOutcome(p, ok) {
  const h = getHealth(p.name);
  h.outcomes.push(ok);
  if (h.outcomes.length > BREAKER.recentMax) h.outcomes.shift();
  if (ok) {
    h.consecutiveFailures = 0;
    h.cooldownUntil = 0;
  } else {
    h.consecutiveFailures++;
    const recent = h.outcomes.slice(-BREAKER.recentMax);
    const recentFailures = recent.filter((x) => x === false).length;
    // Trip the breaker on EITHER 3 consecutive failures OR 3 cumulative
    // failures in the recent window (rate-limit storms trip fast even under
    // rotation, which spreads attempts so consecutive rarely reaches 3).
    if (h.consecutiveFailures >= BREAKER.failureThreshold || recentFailures >= BREAKER.failureThreshold) {
      h.cooldownUntil = Date.now() + BREAKER.cooldownMs;
    }
  }
}
function selectable(p) {
  if (!p.apiKey || !p.baseURL) return false;
  if (p._forcedDown) return false;
  if (isUnhealthy(p)) return false;
  return true;
}

// Forced-failure set (used by the failover drill + tests). When a provider is
// in this set, any attempt to call it throws a synthetic 429 so we can prove
// traffic moves to the next provider exactly as intended.
const _forcedFail = new Set();
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
  for (const p of PROVIDERS) p._forcedDown = false;
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
  errors: 0,
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
    unhealthy: isUnhealthy({ name: n }),
    consecutiveFailures: h.consecutiveFailures,
    cooldownUntil: h.cooldownUntil,
    successRatio: h.outcomes.length ? h.outcomes.filter(Boolean).length / h.outcomes.length : 1,
  }));
  const unhealthy = health.filter((h) => h.unhealthy).map((h) => h.provider);
  const fallbackRate = _metrics.selections ? _metrics.fallbacks / _metrics.selections : 0;
  return {
    ..._metrics,
    fallbackRate,
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
    try {
      const r = await callProviderOnce(p, { messages, max_tokens: MT, temperature: TEMP, stream });
      const latency = Date.now() - pt0;
      recordOutcome(p, true);
      bump(_metrics.byProvider, p.name);
      const reason = tried.length ? `fallback_after:${tried.join(",")}` : "ok";
      if (tried.length) bump(_metrics, "fallbacks");
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
      return { ...r, meta };
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
