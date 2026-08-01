import { jsonResponse } from "./_helpers.js";
import { tokenCookieConfigured } from "./_token-cookie.js";

export const config = { runtime: "edge" };

export default async function handler() {
  return jsonResponse({
    // Both halves are required: the secret to redeem an authorization code,
    // and the encryption key to store the resulting refresh token. With
    // either missing the client stays on the implicit flow, which needs
    // neither. This is what makes the upgrade a config change rather than a
    // deploy — and what stops a half-configured deploy from breaking sign-in.
    hasRefreshTokens: tokenCookieConfigured(),
    pickerApiKey: process.env.GOOGLE_PICKER_API_KEY || null,
  });
}
