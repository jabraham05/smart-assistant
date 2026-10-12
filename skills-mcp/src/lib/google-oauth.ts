import type { Config } from "../config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Cached at module scope, not per-request - same reasoning spotify.ts's
// own getAccessToken already documents for itself: a Google access token
// is valid for an hour, so refreshing it on every tool call would be both
// slow and needlessly hit the token endpoint. Shared by google-calendar.ts
// and google-drive.ts - one Google account, one cached token, regardless
// of which API it's used against (both are requested in the same OAuth
// consent, see scripts/google-auth.mjs).
let cachedAccessToken: string | null = null;
let cachedExpiresAt = 0; // epoch ms

export async function getGoogleAccessToken(config: Config): Promise<string> {
  if (!config.googleOauthClientId || !config.googleOauthClientSecret || !config.googleRefreshToken) {
    throw new Error(
      "Google is not configured (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / " +
        "GOOGLE_REFRESH_TOKEN not set — run scripts/google-auth.mjs to bootstrap).",
    );
  }

  // 60s safety margin so a token doesn't expire mid-request - same margin
  // spotify.ts uses for the same reason.
  if (cachedAccessToken && Date.now() < cachedExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.googleRefreshToken,
      client_id: config.googleOauthClientId,
      client_secret: config.googleOauthClientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google token refresh failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = json.access_token;
  cachedExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedAccessToken;
}
