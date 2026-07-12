// api/router-drill.js — controlled, authenticated outage drill for the AI router.
//
// Lets an operator (Pepuldo) force one provider to look "down" for live
// traffic, to PROVE fallovers fire end-to-end with real provider keys
// (check #3: "a controlled outage drill is the only full proof").
//
// The forced-down state lives in KV (set via setDrillDown in ai-router.js) so
// it survives across serverless instances — unlike the in-memory forceProviderDown
// used by unit tests. Every change is appended to a drill log in KV.
//
// SECURITY: requires `Authorization: Bearer <DRILL_KEY>` where DRILL_KEY is a
// secret set in the Vercel env. Without it the endpoint refuses all writes.
// Anyone can GET (read-only) so you can watch the drill state + log.
import { setDrillDown, getDrillState } from "./ai-router.js";

export const config = { runtime: "edge" };

const DRILL_KEY = process.env.DRILL_KEY;

export default async function handler(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  if (req.method === "GET") {
    const state = await getDrillState();
    return new Response(JSON.stringify(state), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }

  if (!DRILL_KEY || token !== DRILL_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized: DRILL_KEY required" }), { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.provider !== "string" || !["up", "down"].includes(body.state)) {
    return new Response(JSON.stringify({ error: "body must be { provider, state: 'up'|'down' }" }), { status: 400 });
  }

  const res = await setDrillDown(body.provider, body.state === "down");
  if (!res.ok) return new Response(JSON.stringify(res), { status: 500 });
  return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
}
