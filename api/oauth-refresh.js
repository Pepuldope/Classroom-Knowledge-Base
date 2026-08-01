import { jsonResponse } from "./_helpers.js";
import { openToken, readCookie, buildClearCookie } from "./_token-cookie.js";

export const config = { runtime: "edge" };

const CLIENT_ID = "786778645862-cejadrqj2edabpdlk0emsvb1gc2hdijs.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Mint a fresh access token from the refresh token in the caller's own cookie.
//
// Note what this handler does NOT do: accept an identifier naming whose token
// to use. It reads the credential the browser presents and nothing else, so
// there is no request a third party can construct to obtain someone else's
// access token. An earlier version took Google's `sub` from the request body,
// which is a public identifier — that was an account-takeover hole.
export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!CLIENT_SECRET) return jsonResponse({ error: "GOOGLE_CLIENT_SECRET not configured" }, 500);

  const refreshToken = await openToken(readCookie(req));
  if (!refreshToken) {
    return jsonResponse({ error: "no_refresh_token" }, 401, { "Set-Cookie": buildClearCookie() });
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const tokens = await r.json().catch(() => ({}));
  if (!r.ok || !tokens.access_token) {
    // A revoked or expired grant is dead for good — drop the cookie so the
    // client stops retrying and falls back to interactive sign-in.
    if (tokens.error === "invalid_grant") {
      return jsonResponse({ error: "refresh_invalid" }, 401, { "Set-Cookie": buildClearCookie() });
    }
    return jsonResponse({ error: "refresh_failed", details: tokens }, 502);
  }
  return jsonResponse({
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
  });
}
