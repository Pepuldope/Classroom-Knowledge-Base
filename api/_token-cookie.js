// _token-cookie.js — the refresh token lives in an encrypted, httpOnly cookie.
//
// Why a cookie and not a store: a refresh token is a long-lived key to a
// user's Classroom data, and it is only ever needed by the browser that
// earned it. Keeping it in a server-side store means the refresh endpoint has
// to look tokens up by some identifier the client supplies — and an
// identifier the client supplies can be supplied by any client. The previous
// design took Google's `sub` from the request body, which is not a secret, so
// anyone who knew a user's sub could mint access tokens for them. A cookie
// removes that class of bug: the browser presents the credential itself, so
// there is nothing to look up and nothing to impersonate.
//
// httpOnly keeps it out of reach of page scripts (so an XSS cannot read it),
// Secure keeps it off plaintext connections, SameSite=Lax keeps it off
// cross-site requests, and Path=/api means it is only ever sent to the
// endpoints that need it.

export const REFRESH_COOKIE = "cwa_rt";
const SIX_MONTHS_SEC = 60 * 60 * 24 * 180;
const IV_BYTES = 12;

function encKeyMaterial() {
  return process.env.TOKEN_ENC_KEY || "";
}

/** True when the server is configured to hold refresh tokens at all. */
export function tokenCookieConfigured() {
  return !!encKeyMaterial() && !!process.env.GOOGLE_CLIENT_SECRET;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (base64UrlEncode(out) !== value) throw new Error("non-canonical base64url");
  return out;
}

async function importKey() {
  const material = encKeyMaterial();
  if (!material) throw new Error("TOKEN_ENC_KEY not configured");
  const raw = base64UrlDecode(material);
  if (raw.length !== 32) throw new Error("TOKEN_ENC_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** AES-GCM encrypt, returning base64url(iv || ciphertext+tag). */
export async function sealToken(token) {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token))
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  return base64UrlEncode(packed);
}

/**
 * Reverse of sealToken. Returns null rather than throwing for any malformed,
 * truncated or tampered value — GCM's auth tag makes tampering a decrypt
 * failure, and a failure here should read as "no session", never as a 500.
 */
export async function openToken(value) {
  if (!value) return null;
  try {
    const packed = base64UrlDecode(value);
    if (packed.length <= IV_BYTES) return null;
    const key = await importKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: packed.slice(0, IV_BYTES) },
      key,
      packed.slice(IV_BYTES)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/** Read one cookie off a Request. */
export function readCookie(req, name = REFRESH_COOKIE) {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return "";
}

export function buildSetCookie(sealed, maxAge = SIX_MONTHS_SEC) {
  return `${REFRESH_COOKIE}=${sealed}; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=${maxAge}`;
}

export function buildClearCookie() {
  return `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=0`;
}
