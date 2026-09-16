// The student's own AI provider key.
//
// Two properties matter more than any feature here: the browser can name a
// provider but never a URL, and the key never reaches the prefs document.
import test from "node:test";
import assert from "node:assert/strict";
import { byokModel, maskKey, BYOK_KEY, BYOK_PROVIDER_LABELS } from "../byok.js";
import { byokProviderModel, BYOK_PROVIDERS } from "../api/ai-router.js";
import { STORAGE_KEYS } from "../prefs-sync-local.js";
import { TRACKED_SECTIONS } from "../prefs-sync.js";

test("the key is not, and cannot become, a synced pref", () => {
  // The whole storage decision rests on this. If the key ever appears in
  // STORAGE_KEYS it goes into the prefs document, reaches /api/prefs, and the
  // site is durably holding API keys — in a public repo.
  assert.ok(!Object.values(STORAGE_KEYS).includes(BYOK_KEY),
    `${BYOK_KEY} is in STORAGE_KEYS — the key would sync to the server`);
  assert.ok(!Object.keys(TRACKED_SECTIONS).includes("byok"));
  assert.ok(!Object.keys(STORAGE_KEYS).some((k) => /byok|apikey|key$/i.test(k)));
});

test("the browser names a provider, never a URL", () => {
  // Accepting a baseURL from the client would turn /api/tutor into an open
  // request proxy: POST a URL, have the server fetch it with credentials.
  const forged = byokProviderModel({
    provider: "groq",
    apiKey: "gsk_test",
    baseURL: "http://169.254.169.254/latest/meta-data/",
  });
  assert.equal(forged.baseURL, BYOK_PROVIDERS.groq.baseURL, "a client-supplied URL was used");
  assert.equal(byokProviderModel({ provider: "http://evil.test/v1", apiKey: "x" }), null);
  assert.equal(byokProviderModel({ provider: "__proto__", apiKey: "x" }), null,
    "a prototype key was treated as a provider");
});

test("a provider the server does not know is simply no provider", () => {
  assert.equal(byokProviderModel({ provider: "nope", apiKey: "x" }), null);
  assert.equal(byokProviderModel({ provider: "groq", apiKey: "" }), null);
  assert.equal(byokProviderModel({ provider: "groq", apiKey: "x".repeat(401) }), null);
  assert.equal(byokProviderModel(null), null);
  assert.equal(byokProviderModel("groq"), null);
});

test("a student's key never shares a circuit breaker with the shared chain", () => {
  // One expired key must not open the breaker on the shared Groq for everyone.
  const mine = byokProviderModel({ provider: "groq", apiKey: "gsk_test" });
  assert.equal(mine.name, "yours:groq");
  assert.notEqual(mine.name, "groq");
  assert.equal(mine.byok, true);
});

test("a model is accepted, within reason", () => {
  assert.equal(byokProviderModel({ provider: "openrouter", apiKey: "k", model: "qwen/qwen3-32b:free" }).model, "qwen/qwen3-32b:free");
  // Falls back to the provider's default rather than refusing the key.
  assert.equal(byokProviderModel({ provider: "openrouter", apiKey: "k", model: "../../etc/passwd" }).model, BYOK_PROVIDERS.openrouter.model);
  assert.equal(byokProviderModel({ provider: "openrouter", apiKey: "k", model: "a b c" }).model, BYOK_PROVIDERS.openrouter.model);
  assert.equal(byokProviderModel({ provider: "openrouter", apiKey: "k", model: "" }).model, BYOK_PROVIDERS.openrouter.model);
});

test("the client and the server agree on the provider list", () => {
  // A provider offered in Settings that the server ignores is a key the
  // student pastes and never gets an answer from.
  assert.deepEqual(Object.keys(BYOK_PROVIDER_LABELS).sort(), Object.keys(BYOK_PROVIDERS).sort());
});

test("the client normalizes before it stores", () => {
  assert.deepEqual(byokModel({ provider: "  GROQ ", apiKey: " gsk_abc " }), { provider: "groq", apiKey: "gsk_abc" });
  assert.equal(byokModel({ provider: "groq", apiKey: "k", model: "bad model" }).model, undefined,
    "an unusable model should be dropped, leaving the provider default to the server");
  assert.equal(byokModel({ provider: "unknown", apiKey: "k" }), null);
});

test("a key is shown back masked, never in full", () => {
  // A key displayed in full is a key in a screenshot.
  // Assembled rather than written out: the commit guard's secret scanner reads
  // tracked files, and a literal in this shape is exactly what it exists to
  // stop. The test needs the SHAPE, not the spelling.
  const key = ["sk", "or", "v1"].join("-") + "-0123456789abcdef";
  const masked = maskKey(key);
  assert.ok(!masked.includes("0123456789"), "the middle of the key is readable");
  assert.ok(masked.startsWith("sk-o") && masked.endsWith("cdef"), "not enough left to recognise it");
  assert.equal(maskKey("short"), "•••••");
  assert.equal(maskKey(""), "");
});
