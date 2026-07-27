import type { Config } from "../config.js";

const API_BASE = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

// Cached at module scope, not per-request: a Spotify access token is
// valid for an hour, so refreshing it on every tool call would be both
// slow and needlessly hit the token endpoint. Mirrors the same reasoning
// lib/google-calendar.ts already documents for its own cached auth client.
let cachedAccessToken: string | null = null;
let cachedExpiresAt = 0; // epoch ms

async function getAccessToken(config: Config): Promise<string> {
  if (!config.spotifyClientId || !config.spotifyClientSecret || !config.spotifyRefreshToken) {
    throw new Error(
      "Spotify is not configured (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / " +
        "SPOTIFY_REFRESH_TOKEN not set — run scripts/spotify-auth.mjs to bootstrap).",
    );
  }

  // 60s safety margin so a token doesn't expire mid-request.
  if (cachedAccessToken && Date.now() < cachedExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const basicAuth = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString(
    "base64",
  );
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.spotifyRefreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Spotify token refresh failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = json.access_token;
  cachedExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedAccessToken;
}

// The single most likely real-world failure: nothing is actively
// playing/connected anywhere (phone asleep, no app open). Spotify
// reports this as a 404 with a specific reason code - worth a clear,
// distinct message rather than a raw API error.
async function isNoActiveDeviceError(res: Response): Promise<boolean> {
  if (res.status !== 404) return false;
  const body = await res.clone().text().catch(() => "");
  return body.includes("NO_ACTIVE_DEVICE");
}

async function spotifyFetch(config: Config, path: string, init?: RequestInit): Promise<unknown> {
  const token = await getAccessToken(config);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    if (await isNoActiveDeviceError(res)) {
      throw new Error("No active Spotify device — open Spotify on a phone, computer, or speaker first.");
    }
    const body = await res.text().catch(() => "");
    throw new Error(`Spotify API failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface SpotifySearchResult {
  uri: string;
  name: string;
  artists?: string;
}

export type SpotifySearchType = "track" | "artist" | "album" | "playlist";

export async function search(
  config: Config,
  query: string,
  type: SpotifySearchType,
  limit: number,
): Promise<SpotifySearchResult[]> {
  const params = new URLSearchParams({ q: query, type, limit: String(limit) });
  const data = (await spotifyFetch(config, `/search?${params}`)) as Record<
    string,
    { items: Array<{ uri: string; name: string; artists?: Array<{ name: string }> }> }
  >;
  const key = `${type}s`; // Spotify pluralizes the result key, e.g. "tracks", "artists"
  const items = data[key]?.items ?? [];
  return items.map((item) => ({
    uri: item.uri,
    name: item.name,
    artists: item.artists?.map((a) => a.name).join(", "),
  }));
}

export async function play(config: Config, opts?: { uris?: string[]; contextUri?: string }): Promise<void> {
  const body = opts?.uris
    ? { uris: opts.uris }
    : opts?.contextUri
      ? { context_uri: opts.contextUri }
      : undefined;
  await spotifyFetch(config, "/me/player/play", {
    method: "PUT",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function pause(config: Config): Promise<void> {
  await spotifyFetch(config, "/me/player/pause", { method: "PUT" });
}

export async function next(config: Config): Promise<void> {
  await spotifyFetch(config, "/me/player/next", { method: "POST" });
}

export async function previous(config: Config): Promise<void> {
  await spotifyFetch(config, "/me/player/previous", { method: "POST" });
}

export interface CurrentlyPlaying {
  isPlaying: boolean;
  trackName?: string;
  artists?: string;
  progressMs?: number;
  durationMs?: number;
}

export async function getCurrentlyPlaying(config: Config): Promise<CurrentlyPlaying | null> {
  const data = (await spotifyFetch(config, "/me/player/currently-playing")) as {
    is_playing?: boolean;
    progress_ms?: number;
    item?: { name: string; duration_ms: number; artists?: Array<{ name: string }> };
  } | null;
  if (!data || !data.item) return null;
  return {
    isPlaying: !!data.is_playing,
    trackName: data.item.name,
    artists: data.item.artists?.map((a) => a.name).join(", "),
    progressMs: data.progress_ms,
    durationMs: data.item.duration_ms,
  };
}

export async function addToQueue(config: Config, uri: string): Promise<void> {
  const params = new URLSearchParams({ uri });
  await spotifyFetch(config, `/me/player/queue?${params}`, { method: "POST" });
}

export async function setVolume(config: Config, percent: number): Promise<void> {
  const params = new URLSearchParams({ volume_percent: String(percent) });
  await spotifyFetch(config, `/me/player/volume?${params}`, { method: "PUT" });
}
