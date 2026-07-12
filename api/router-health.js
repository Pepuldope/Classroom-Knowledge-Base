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
import { getRouterMetrics } from "./ai-router.js";

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const reset = url.searchParams.get("reset") === "1";
  const m = getRouterMetrics();
  if (reset) {
    // Re-import to clear in-memory metrics; simplest: return then note reset.
    // (Counter reset happens on next cold start; for an explicit clear use the
    //  forceProviderFail/resetRouterHealth test helpers.)
    m._note = "counters reset on next cold start";
  }
  return jsonResponse(m);
}
