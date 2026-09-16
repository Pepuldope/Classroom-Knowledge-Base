// byok.js — the student's own AI provider key.
//
// Peter's call, 2026-09-16: the key lives in THIS BROWSER and is sent with each
// tutor request. It is never written to the prefs document, so it never reaches
// /api/prefs, the KV store, or the student's other devices — a key that syncs
// is a key the site is durably holding, and this repo is public.
//
// That is a deliberate trade: setting it up again on a second device is the
// price of the site never being worth attacking for its key store.
//
// The browser cannot call most providers directly (CORS), so the key does cross
// the wire to our own function, which uses it for that one request and neither
// stores nor logs it. api/ai-router.js decides the ENDPOINT from the provider
// name; the browser never sends a URL.

/** Not in prefs-sync-local's STORAGE_KEYS, and must never be added to it. */
export const BYOK_KEY = "cwa_ai_byok";

/** Must match BYOK_PROVIDERS in api/ai-router.js — an unknown name is ignored there. */
export const BYOK_PROVIDER_LABELS = {
  openrouter: "OpenRouter",
  groq: "Groq",
  google: "Google Gemini",
  mistral: "Mistral",
  cerebras: "Cerebras",
  openai: "OpenAI",
};

const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,120}$/;
const KEY_MAX = 400;

/**
 * Normalize what is stored, and what is sent.
 *
 * Returns null for "no key set", which is the common case and the one every
 * caller has to handle: a request simply carries no `byok` field.
 */
export function byokModel(value) {
  if (!value || typeof value !== "object") return null;
  const provider = typeof value.provider === "string" ? value.provider.trim().toLowerCase() : "";
  if (!Object.prototype.hasOwnProperty.call(BYOK_PROVIDER_LABELS, provider)) return null;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  if (!apiKey || apiKey.length > KEY_MAX) return null;
  const asked = typeof value.model === "string" ? value.model.trim() : "";
  const model = asked && MODEL_RE.test(asked) && !asked.includes("..") ? asked : "";
  return model ? { provider, apiKey, model } : { provider, apiKey };
}

export function loadByok() {
  try { return byokModel(JSON.parse(localStorage.getItem(BYOK_KEY) || "null")); }
  catch { return null; }
}

export function saveByok(value) {
  const model = byokModel(value);
  try {
    if (model) localStorage.setItem(BYOK_KEY, JSON.stringify(model));
    else localStorage.removeItem(BYOK_KEY);
  } catch { /* private mode */ }
  return model;
}

export function clearByok() {
  try { localStorage.removeItem(BYOK_KEY); } catch {}
}

/**
 * What a tutor request body should spread in: `{ byok }` or nothing at all.
 *
 * A helper rather than each caller reaching for loadByok, so there is one place
 * that decides a request carries a key — and one place to look when asking
 * whether it ever carries anything else.
 */
export function byokRequestFields() {
  const model = loadByok();
  return model ? { byok: model } : {};
}

/**
 * How the key should be shown back to the reader: enough to recognise, never
 * enough to use. Pasting a key into a page and having the page display it in
 * full is how a key ends up in a screenshot.
 */
export function maskKey(apiKey) {
  const s = String(apiKey || "");
  if (!s) return "";
  if (s.length <= 8) return "•".repeat(s.length);
  return `${s.slice(0, 4)}${"•".repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}
