// ai-router.js — multi-provider AI router with automatic failover.
// Used by the tutor (and any agent loop) so we use as many models as possible
// and gracefully fall through when one is rate-limited / down.
//
// Edge-safe: only uses the global `fetch` (Web standard) — no node:* imports.
//
// Each provider entry: { name, baseURL, apiKey, model, extra? }
// We try them in priority order; on 429 / network / non-JSON we move on.
// A provider can supply `stream:true` to get Server-Sent-Events back.

export const PROVIDERS = [
  // 1. OpenRouter — broadest model choice (Nemotron, DeepSeek, Qwen…)
  {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "nvidia/nemotron-3-nano-30b-a3b:free",
    headers: { "HTTP-Referer": "https://classroom-knowledge-base.vercel.app", "X-Title": "Classroom KB" },
  },
  // 2. Local FreeLLMAPI proxy — never rate-limited, runs many models via "auto"
  {
    name: "freellmapi",
    baseURL: (process.env.FREELLMAPI_BASE_URL || "http://127.0.0.1:3001") + "/v1/chat/completions",
    apiKey: process.env.FREELLMAPI_API_KEY,
    model: "auto",
  },
  // 3. Groq — very fast
  {
    name: "groq",
    baseURL: (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1") + "/chat/completions",
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile",
  },
  // 4. Cerebras — fast inference
  {
    name: "cerebras",
    baseURL: (process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1") + "/chat/completions",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: "llama3.1-70b",
  },
  // 5. Mistral
  {
    name: "mistral",
    baseURL: (process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1") + "/chat/completions",
    apiKey: process.env.MISTRAL_API_KEY,
    model: "mistral-large-latest",
  },
  // 6. NVIDIA — DeepSeek v4
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1/chat/completions",
    apiKey: process.env.NVIDIA_API_KEY,
    model: "deepseek-ai/deepseek-v4-pro",
  },
  // 7. GitHub Models
  {
    name: "github",
    baseURL: (process.env.GITHUB_BASE_URL || "https://models.inference.ai.azure.com") + "/chat/completions",
    apiKey: process.env.GITHUB_API_KEY,
    model: "gpt-4o-mini",
  },
  // 8. Qwen
  {
    name: "qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    apiKey: process.env.QWEN_API_KEY,
    model: "qwen-max",
  },
  // 9. Google Gemini (OpenAI-compatible mode)
  {
    name: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKey: process.env.GOOGLE_API_KEY,
    model: "gemini-2.5-flash",
    extra: { thinkingBudget: 0 }, // long answers shouldn't be truncated
  },
];

function enabledProviders() {
  return PROVIDERS.filter((p) => p.apiKey && p.baseURL);
}

/**
 * Call the first available provider, failing over on error/rate-limit.
 * Returns { text, provider, model } or throws after all fail.
 * If `stream` is true, returns a Response-like stream from the first
 * provider that supports streaming (falls back to non-stream on others).
 */
export async function routeChat(messages, opts = {}) {
  const { max_tokens = 4000, temperature = 0.4, stream = false } = opts;
  const providers = enabledProviders();
  if (providers.length === 0) throw new Error("No AI providers configured");

  let lastErr = null;
  for (const p of providers) {
    try {
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
