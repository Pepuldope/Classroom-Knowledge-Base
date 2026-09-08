// auth-session.js — browser-local OAuth access-token persistence.
// The token is kept in the existing IndexedDB store used by archive.js. No
// access-token value is written to localStorage/sessionStorage.

import { idbGet, idbPut, idbDelete } from "./archive.js";

const AUTH_SESSION_ID = "auth-session";
const LEGACY_TOKEN_KEYS = ["cwa_token_v9", "cwa_kb_token"];

export function tokenRecordModel(value, now = Date.now()) {
  if (!value || typeof value !== "object") return null;
  const token = typeof value.token === "string" ? value.token.trim() : "";
  const expiresAt = Number(value.expiresAt);
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { token, expiresAt };
}

export function authStoragePolicy() {
  return {
    persistentStore: "IndexedDB",
    legacyTokenKeys: [...LEGACY_TOKEN_KEYS],
    clearLegacyTokenOnRead: true,
    clearLegacyTokenOnSignOut: true,
  };
}

function clearLegacyToken() {
  for (const key of LEGACY_TOKEN_KEYS) {
    try { localStorage.removeItem(key); } catch {}
  }
}

function readLegacyToken() {
  try {
    let legacy = null;
    for (const key of LEGACY_TOKEN_KEYS) {
      const raw = localStorage.getItem(key);
      if (!legacy && raw) legacy = tokenRecordModel(JSON.parse(raw));
    }
    clearLegacyToken();
    return legacy;
  } catch {
    clearLegacyToken();
    return null;
  }
}

export async function loadStoredAuthSession() {
  const stored = tokenRecordModel(await idbGet(AUTH_SESSION_ID).catch(() => null));
  if (stored) return stored;
  const legacy = readLegacyToken();
  if (!legacy) return null;
  await idbPut({ id: AUTH_SESSION_ID, ...legacy }).catch(() => {});
  return legacy;
}

export async function storeAuthSession(token, expiresInSec, now = Date.now()) {
  const seconds = Number(expiresInSec);
  const record = tokenRecordModel({
    token,
    expiresAt: now + (Number.isFinite(seconds) ? (seconds - 30) * 1000 : 0),
  }, now);
  if (!record) return null;
  await idbPut({ id: AUTH_SESSION_ID, ...record });
  clearLegacyToken();
  return record;
}

export async function clearAuthSession() {
  clearLegacyToken();
  await idbDelete(AUTH_SESSION_ID).catch(() => {});
}

/**
 * Whether a returning page needs its session re-checked before it is used.
 *
 * A phone does not reload the page when you switch away and come back: it
 * freezes it and restores it (bfcache), so no boot code runs, no timer fired
 * while it was frozen, and the access token may well have expired in the
 * meantime. The first Classroom call then 401s, and the recovery from there is
 * what the user experiences as "it wants me to sign in".
 *
 * `persisted` is `PageTransitionEvent.persisted` — true only for a bfcache
 * restore. A tab merely becoming visible is checked too, but only when the
 * token is at or near expiry, so ordinary tab switching costs nothing.
 */
export function sessionResumeModel({ persisted = false, visible = true, expiresAt = 0, now = Date.now(), skewMs = 60_000 } = {}) {
  if (!visible) return { recheck: false, reason: "hidden" };
  const expiry = Number(expiresAt);
  const expired = !Number.isFinite(expiry) || expiry - skewMs <= now;
  if (persisted) return { recheck: true, reason: expired ? "restored-expired" : "restored" };
  if (expired) return { recheck: true, reason: "expired" };
  return { recheck: false, reason: "fresh" };
}
