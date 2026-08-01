// auth-redirect.js — full-page redirect sign-in, no popup.
//
// The popup flows (GIS initTokenClient / initCodeClient with ux_mode "popup")
// leave some browsers' compositors wedged when the popup closes: the app's DOM
// is present, laid out and hit-testable, but nothing repaints until the tab is
// backgrounded and refocused. A full-page redirect has no popup and no opener
// relationship, so there is nothing to wedge — the token arrives on a fresh
// document load.
//
// This uses the OAuth 2.0 implicit flow (response_type=token) deliberately: it
// needs no client secret and no server callback route, so it works on a
// deployment where GOOGLE_CLIENT_SECRET is unset. The trade-off is that no
// refresh token is issued — which costs nothing here, because a deployment
// without the secret cannot mint or store refresh tokens anyway.

export const AUTH_STATE_KEY = "cwa_auth_state";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/** Build the Google authorization URL to navigate the top-level page to. */
export function buildAuthRedirectUrl({ clientId, scope, redirectUri, state, prompt = "select_account", loginHint = "" }) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("scope", scope);
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  if (prompt) url.searchParams.set("prompt", prompt);
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  return url.toString();
}

/**
 * Read the fragment Google redirects back with.
 *
 * Returns null when this is an ordinary page load (no auth fragment), an
 * object with `error` when the attempt failed or the state does not match,
 * and `{ token, expiresIn }` on success. The state check is what stops a
 * third party from feeding us a token by handing the user a crafted link.
 */
export function parseAuthRedirectHash(hash, expectedState) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return null;

  const params = new URLSearchParams(raw);
  const state = params.get("state");
  const error = params.get("error");
  const token = params.get("access_token");
  // Not an auth redirect at all — leave ordinary fragments (deep links) alone.
  if (!state && !error && !token) return null;

  if (!expectedState || state !== expectedState) return { error: "state_mismatch" };
  if (error) return { error };
  if (!token) return { error: "no_token" };

  const expiresIn = Number(params.get("expires_in"));
  return { token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600 };
}

/** Cryptographically random state value, hex encoded. */
export function randomState(crypto = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
