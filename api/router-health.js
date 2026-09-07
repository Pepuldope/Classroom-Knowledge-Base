// api/router-health.js — production canary for AI-router fallback frequency.
//
// Returns live breaker/health state + fallback counters so you can watch for a
// provider that's failing a lot. Pairs with the [router] console logs emitted
// on every routing decision (queryable in the Vercel function logs).
//
// GET /api/router-health  -> { selections, fallbacks, fallbackRate, health[],
//                              alert, unhealthy[] }
// GET /api/router-health?reset=1 -> clears counters after reading (drill/debug)
import { jsonResponse } from "./_helpers.js";
import { getRouterMetrics, resetRouterMetrics, listProviderAvailability } from "./ai-router.js";

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const reset = url.searchParams.get("reset") === "1";
  const m = getRouterMetrics();
  if (reset) resetRouterMetrics();
  // Which storage credentials this deployment can see, by name only — never
  // a value. A store connected under one naming while the code reads another
  // is invisible otherwise: every caller simply reports "not configured".
  const storage = {
    KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
    UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  storage.resolved = !!((storage.KV_REST_API_URL || storage.UPSTASH_REDIS_REST_URL) &&
                        (storage.KV_REST_API_TOKEN || storage.UPSTASH_REDIS_REST_TOKEN));
  return jsonResponse({ ...m, providers: listProviderAvailability(), storage });
}
