// ai-router.js — multi-provider AI router with automatic failover.
// Used by the tutor (and any agent loop) so we use as many models as possible
// and gracefully fall through when one is rate-limited / down.
//
// Edge-safe: only uses the global `fetch` (Web standard) — no node:* imports.
//
// Each provider entry: { name, baseURL, apiKey, model, extra? }
// We try them in priority order; on 429 / network / non-JSON we move on.
// A provider can supply `stream:true` to get Server-Sent-Events back.

// Each provider entry: { name, baseURL, apiKey, model, effort, extra? }
// `effort` (1-3) lets us pick strong models for hard tasks and fast ones for
// easy ones. We no longer lead with a weak free model — the router prefers
// capable models first and fails over, so quality is high by default.
export const PROVIDERS = [
  // 1. NVIDIA — DeepSeek v4 Flash (strong, fast, reliable free tier; default workhorse)
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1/chat/completions",
    apiKey: process.env.NVIDIA_API_KEY,
    model: "deepseek-ai/deepseek-v4-flash",
    effort: 3,
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
export async function routeChat(messages, opts = {}) {
  const {
    max_tokens,
    temperature,
    stream = false,
    task = "default",
    effortMin = 1,
  } = opts;

  const TASK_PROFILES = {
    hard:    { max_tokens: 8000, temperature: 0.3 },
    tutor:   { max_tokens: 6000, temperature: 0.5 },
    default: { max_tokens: 4000, temperature: 0.4 },
    quick:   { max_tokens: 1500, temperature: 0.7 },
  };
  const profile = TASK_PROFILES[task] || TASK_PROFILES.default;
  const MT = max_tokens ?? profile.max_tokens;
  const TEMP = temperature ?? profile.temperature;

  let providers = enabledProviders().filter((p) => (p.effort || 1) >= effortMin);
  if (providers.length === 0) providers = enabledProviders(); // fall back to anything
  if (providers.length === 0) throw new Error("No AI providers configured");

  // Rotate the starting point so successive calls hit different providers.
  const start = _rotate % providers.length;
  _rotate = (_rotate + 1) % providers.length;
  const ordered = [...providers.slice(start), ...providers.slice(0, start)];

  let lastErr = null;
  for (const p of ordered) {
    try {
      const body = {
        model: p.model,
        messages,
        max_tokens: MT,
        temperature: TEMP,
        stream,
        ...(p.extra || {}),
      };
      const headers = {
        Authorization: `Bearer ${p.apiKey}`,
        "Content-Type": "application/json",
        ...(p.headers || {}),
      };
      const res = await fetch(p.baseURL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status === 401 || res.status >= 500) {
        lastErr = new Error(`${p.name} HTTP ${res.status}`);
        continue; // try next provider
      }
      if (!res.ok) {
        lastErr = new Error(`${p.name} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
        continue;
      }
      if (stream) {
        // Return the raw stream + which provider succeeded (for SSE relay).
        return { stream: res.body, provider: p.name, model: p.model, response: res };
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      return { text, provider: p.name, model: p.model };
    } catch (e) {
      lastErr = e;
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
