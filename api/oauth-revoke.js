import { jsonResponse } from "./_helpers.js";
import { openToken, readCookie, buildClearCookie } from "./_token-cookie.js";

export const config = { runtime: "edge" };

// Drop this browser's refresh token, and tell Google to forget the grant.
//
// This is what actually lets a user SWITCH accounts: without it the next page
// load silently re-grants a token for the previous account, so clearing the
// client-side token alone never escapes a wrong (e.g. non-Classroom) account.
//
// Like oauth-refresh, it acts only on the credential the caller presents.
// Taking a `sub` from the body — as this once did — let anyone delete anyone
// else's stored grant.
export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const refreshToken = await openToken(readCookie(req));
  if (refreshToken) {
    // Best effort: if Google rejects it the grant is already gone, and the
    // cookie is cleared either way.
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    }).catch(() => {});
  }
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": buildClearCookie() });
}
