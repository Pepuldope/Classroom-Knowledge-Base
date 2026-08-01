// auth-redirect.js — full-page redirect sign-in, no popup.
//
// The popup flows (GIS initTokenClient / initCodeClient with ux_mode "popup")
// leave some browsers' compositors wedged when the popup closes: the app's DOM
// is present, laid out and hit-testable, but nothing repaints until the tab is
// backgrounded and refocused. A full-page redirect has no popup and no opener
// relationship, so there is nothing to wedge — the token arrives on a fresh
// document load.
//
// Two response types are supported, chosen at runtime from /api/oauth-config:
//
//   "code"  — authorization code flow. Google returns ?code= in the QUERY
//             string; the server redeems it with the client secret and gets a
//             refresh token, so the session survives a browser restart.
//             Requires GOOGLE_CLIENT_SECRET and TOKEN_ENC_KEY on the server.
//
//   "token" — implicit flow. Google returns #access_token= in the FRAGMENT.
//             Needs no server configuration at all, but issues no refresh
//             token, so the session dies with the access token (~1 hour).
//
// Keeping both is deliberate: a deployment that has not been configured yet
// still signs in, rather than breaking the moment this ships.

export const AUTH_STATE_KEY = "cwa_auth_state";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/** Build the Google authorization URL to navigate the top-level page to. */
export function buildAuthRedirectUrl({
  clientId,
  scope,
  redirectUri,
  state,
  responseType = "token",
  prompt = "select_account",
  loginHint = "",
}) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", responseType);
  url.searchParams.set("scope", scope);
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  if (responseType === "code") {
    // Without access_type=offline Google issues no refresh token at all, and
    // without consent in the prompt it withholds one on every authorization
    // after the first — which would leave returning users silently stuck on
    // hour-long sessions.
    url.searchParams.set("access_type", "offline");
    if (!prompt.includes("consent")) prompt = `${prompt} consent`.trim();
  }
  if (prompt) url.searchParams.set("prompt", prompt);
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  return url.toString();
}

/**
 * Read whatever Google redirected back with.
 *
 * The code flow answers in the query string and the implicit flow in the
 * fragment, so both are inspected. Returns null for an ordinary page load,
 * `{ error }` on failure or state mismatch, `{ code }` for the code flow and
 * `{ token, expiresIn }` for the implicit flow.
 *
 * The state check is what stops a third party handing the user a crafted link
 * that injects an attacker-controlled code or token.
 */
export function parseAuthRedirectResponse(search, hash, expectedState) {
  const query = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const fragment = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const pick = (key) => query.get(key) ?? fragment.get(key);

  const state = pick("state");
  const error = pick("error");
  const code = pick("code");
  const token = pick("access_token");
  // Not an auth redirect — leave ordinary URLs and deep links alone.
  if (!state && !error && !code && !token) return null;

  if (!expectedState || state !== expectedState) return { error: "state_mismatch" };
  if (error) return { error };
  if (code) return { code };
  if (!token) return { error: "no_token" };

  const expiresIn = Number(fragment.get("expires_in") ?? query.get("expires_in"));
  return { token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600 };
}

/** Cryptographically random state value, hex encoded. */
export function randomState(crypto = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
