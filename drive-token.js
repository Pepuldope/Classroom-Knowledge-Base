// drive-token.js — how the export asks Google for a drive.file token, and how
// long it keeps one. Pure (storage and clock are passed in) so it can be tested
// without GIS.
//
// Why this exists: the Drive request used to go out with no account hint and
// the token lived only in memory. A browser signed into several Google accounts
// (a school account plus a personal one is the normal case) then showed the
// account chooser on every export after a reload, and again every hour, even
// though the student had already granted access. Passing the remembered
// account as `hint` lets Google pick it without asking. `prompt: ""` means
// "show UI only if consent is actually missing", so the first grant still works.
// Keeping the token in sessionStorage until it expires makes a reload in the
// same tab reuse it.

export const DRIVE_TOKEN_KEY = "cwa_drive_token";
// Same margin as before: a request started right at the edge still has time to
// finish before Google 401s it.
export const DRIVE_TOKEN_SAFETY_SEC = 60;

/** Options for driveTokenClient.requestAccessToken(). */
export function driveTokenRequestOptions(hint) {
  const opts = { prompt: "" };
  if (hint) opts.hint = hint;
  return opts;
}

/** Absolute expiry (ms) for a token Google says lives `expiresInSec`. */
export function driveTokenExpiry(expiresInSec, now) {
  const sec = Number(expiresInSec) || 3600;
  return now + Math.max(0, sec - DRIVE_TOKEN_SAFETY_SEC) * 1000;
}

/** A cached token that is still usable at `now`, or null. Never throws. */
export function readCachedDriveToken(storage, now) {
  try {
    const raw = storage?.getItem(DRIVE_TOKEN_KEY);
    if (!raw) return null;
    const { token, expiry } = JSON.parse(raw);
    if (typeof token !== "string" || !token || !(Number(expiry) > now)) return null;
    return { token, expiry: Number(expiry) };
  } catch {
    return null;
  }
}

export function writeCachedDriveToken(storage, token, expiry) {
  try { storage?.setItem(DRIVE_TOKEN_KEY, JSON.stringify({ token, expiry })); } catch {}
}

export function clearCachedDriveToken(storage) {
  try { storage?.removeItem(DRIVE_TOKEN_KEY); } catch {}
}
