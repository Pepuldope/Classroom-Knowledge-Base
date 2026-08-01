import { jsonResponse } from "./_helpers.js";
import { sealToken, buildSetCookie, tokenCookieConfigured } from "./_token-cookie.js";

export const config = { runtime: "edge" };

const CLIENT_ID = "786778645862-cejadrqj2edabpdlk0emsvb1gc2hdijs.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!CLIENT_SECRET) return jsonResponse({ error: "GOOGLE_CLIENT_SECRET not configured" }, 500);

  const body = await req.json().catch(() => null);
  const code = body?.code;
  const redirectUri = body?.redirectUri;
  if (!code) return jsonResponse({ error: "code required" }, 400);
  // The redirect_uri has to be echoed back to Google exactly as it was sent to
  // the authorization endpoint. Pin it to our own origin rather than trusting
  // whatever the caller supplies.
  let sameOrigin = false;
  try {
    sameOrigin = !!redirectUri && new URL(redirectUri).origin === new URL(req.url).origin;
  } catch {}
  if (!sameOrigin) return jsonResponse({ error: "redirect_uri invalid" }, 400);

  const params = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.access_token) {
    return jsonResponse({ error: "token_exchange_failed", details: tokens }, 502);
  }

  const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userinfoRes.ok) return jsonResponse({ error: "userinfo_failed" }, 502);
  const userinfo = await userinfoRes.json();

  const payload = {
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
    sub: userinfo.sub,
    email: userinfo.email,
    name: userinfo.given_name || userinfo.name,
    has_refresh: false,
  };

  // Google only issues a refresh token on first consent unless prompt=consent
  // was sent. Not getting one is not an error — the user just gets a session
  // that ends when the access token does.
  if (!tokens.refresh_token || !tokenCookieConfigured()) return jsonResponse(payload);

  let cookie;
  try {
    cookie = buildSetCookie(await sealToken(tokens.refresh_token));
  } catch {
    return jsonResponse(payload);
  }
  return jsonResponse({ ...payload, has_refresh: true }, 200, { "Set-Cookie": cookie });
}
