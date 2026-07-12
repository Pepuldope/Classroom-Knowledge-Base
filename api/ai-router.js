// ai-router.js — tiered multi-provider AI router with classify-first + failover.
// Encodes Pepuldo's routing policy:
//   - cheapest model that can do the job; escalate only when needed.
//   - classify-first: when no explicit task is given, a cheap/fast model picks
//     the tier (quick/default/hard) before we spend a stronger one.
//   - load-balance within a tier + fail over to another provider on 429/5xx
//     (never retry the same throttled endpoint).
//   - strong (effort 3) models reserved for hard/risky tasks; routine work
//     never hits them.
//
// Edge-safe: only uses the global `fetch` (Web standard) — no node:* imports.
//
// Each provider entry: { name, baseURL, apiKey, model, effort, extra? }
// `effort` is the capability tier: 1 = cheap/free, 2 = mid, 3 = strong.
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
    rpmLimit: 46, // < 48 key-wide ceiling; enforced in routeChat
  },
  // 2. Google Gemini 2.5 Flash (OpenAI-compatible mode, fast + capable)
  {
    name: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKey: process.env.GOOGLE_API_KEY,
    model: "gemini-2.5-flash",
    effort: 2,
    extra: { thinkingBudget: 0 }, // long answers shouldn't be truncated
  },
  // 3. Groq — very fast, good for quick tutor turns
  {
    name: "groq",
    baseURL: (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1") + "/chat/completions",
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile",
    effort: 2,
  },
  // 4. Mistral Large
  {
    name: "mistral",
    baseURL: (process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1") + "/chat/completions",
    apiKey: process.env.MISTRAL_API_KEY,
    model: "mistral-large-latest",
    effort: 2,
  },
  // 5. Cerebras — fast inference
  {
    name: "cerebras",
    baseURL: (process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1") + "/chat/completions",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama3.1-70b",
    effort: 1,
  },
  // 6. GitHub Models (GPT-4o-mini)
  {
    name: "github",
    baseURL: (process.env.GITHUB_BASE_URL || "https://models.inference.ai.azure.com") + "/chat/completions",
    apiKey: process.env.GITHUB_API_KEY,
    model: "gpt-4o-mini",
    effort: 2,
  },
  // 7. Qwen Max
  {
    name: "qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    apiKey: process.env.QWEN_API_KEY,
    model: "qwen-max",
    effort: 2,
  },
  // 8. Local FreeLLMAPI proxy — never rate-limited, many models via "auto"
  {
    name: "freellmapi",
    baseURL: (process.env.FREELLMAPI_BASE_URL || "http://127.0.0.1:3001") + "/v1/chat/completions",
    apiKey: process.env.FREELLMAPI_API_KEY,
    model: "auto",
    effort: 2,
  },
  // 9. OpenRouter — DeepSeek v4 Pro for very-high-intelligence tasks (NVIDIA hosted pro throttles/hangs on free tier, so route via OpenRouter);
  //    not the default (so we don't lean on a single provider / weak model).
  {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "deepseek/deepseek-v4-pro",
    effort: 3,
    headers: { "HTTP-Referer": "https://classroom-knowledge-base.vercel.app", "X-Title": "Classroom KB" },
  },
];

function enabledProviders() {
  return PROVIDERS.filter((p) => p.apiKey && p.baseURL);
}

/**
 * Call a provider, failing over on error/rate-limit. Returns
 * { text, provider, model } or throws after all fail.
 *
 * Variety + effort:
 *  - We rotate the *starting* provider each call (module-level counter) so load
 *    spreads across NVIDIA/Gemini/Groq/Mistral/... instead of always hammering
 *    the first one. Failover still walks the rest in order.
 *  - `task` tunes effort: "tutor"/"hard" -> higher max_tokens + lower temp
 *    (more thoughtful), "quick" -> fast + concise. Defaults to a balanced mid.
 *  - `effortMin` (1-3) skips providers rated below the requested strength, so a
 *    hard task won't land on a weak model unless nothing stronger is available.
 */
let _rotate = 0;

// Single-provider call primitive (used by both routeChat and classifyTask so
// classify never recurses into the full router).
async function callProviderOnce(p, { messages, max_tokens, temperature, stream }) {
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
    e.provider = p.name; e.status = res.status; throw e;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`${p.name} HTTP ${res.status}: ${t.slice(0, 200)}`);
    e.provider = p.name; e.status = res.status; throw e;
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

export async function routeChat(messages, opts = {}) {
  const {
    max_tokens,
    temperature,
    stream = false,
    task: taskIn,
    effortMin = 1,
    classify = true,
  } = opts;

  const TASK_PROFILES = {
    hard:    { max_tokens: 8000, temperature: 0.3 },
    tutor:   { max_tokens: 6000, temperature: 0.5 },
    default: { max_tokens: 4000, temperature: 0.4 },
    quick:   { max_tokens: 1500, temperature: 0.7 },
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
    try { task = await classifyTask(messages); tier = TIER[task] ?? 2; }
    catch { task = "default"; }
  }

  const profile = TASK_PROFILES[task] || TASK_PROFILES.default;
  const MT = max_tokens ?? profile.max_tokens;
  const TEMP = temperature ?? profile.temperature;

  // Main band = providers exactly at the task's tier (cheapest adequate).
  // Fallback = one tier higher (escalation), appended so it's only used when
  // the main band is exhausted (rate-limited / down / 429).
  const all = enabledProviders();
  let main = all.filter((p) => (p.effort || 1) === tier);
  if (main.length === 0) main = all.filter((p) => (p.effort || 1) >= tier);
  if (main.length === 0) main = all;
  const fallback = all.filter((p) => (p.effort || 1) === tier + 1 && !main.includes(p));

  // Load-balance: rotate the starting provider within the main band so no
  // single endpoint gets hammered.
  const start = _rotate % main.length;
  _rotate = (_rotate + 1) % Math.max(1, all.length);
  const ordered = [...main.slice(start), ...main.slice(0, start), ...fallback];
  if (ordered.length === 0) throw new Error("No AI providers configured");

  let lastErr = null;
  for (const p of ordered) {
    // Enforce per-provider RPM caps (e.g. NVIDIA <48/min key-wide limit).
    // Skip + fail over rather than burning the key against the ceiling.
    if (!underRpmLimit(p)) {
      lastErr = new Error(`${p.name} skipped: rpmLimit (${p.rpmLimit}/min) reached`);
      continue;
    }
    try {
      const r = await callProviderOnce(p, { messages, max_tokens: MT, temperature: TEMP, stream });
      return r; // { text, provider, model } or { stream, provider, model, response }
    } catch (e) {
      lastErr = e; // 429 / 5xx / network -> try the next provider (failover)
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
