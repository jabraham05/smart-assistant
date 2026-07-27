import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  addToQueue,
  getCurrentlyPlaying,
  next,
  pause,
  play,
  previous,
  search,
  setVolume,
  type SpotifySearchType,
} from "../lib/spotify.js";
import { errorResult, textResult } from "../types.js";

function notConfiguredResult() {
  return errorResult(
    "Spotify is not configured (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / " +
      "SPOTIFY_REFRESH_TOKEN not set — run scripts/spotify-auth.mjs to bootstrap).",
  );
}

export function registerSpotifyControl(server: McpServer, config: Config): void {
  server.registerTool(
    "spotify_control",
    {
      title: "Spotify control",
      description:
        "Control the user's Spotify playback: play, pause, skip, search, queue, check what's " +
        "playing, or set volume, chosen via the `action` parameter. Use action='current' to " +
        "check what's actually playing before commenting on it — never assume. Use " +
        "action='play' with no query to resume paused playback; with a `query` (and optional " +
        "`searchType`, defaults to 'track'), it searches and plays the top result. Use " +
        "action='search' first if you want to confirm/choose a result before playing or " +
        "queueing it — then pass that result's `uri` to action='play' or action='queue' " +
        "instead of searching again. action='volume' requires an explicit `volumePercent` " +
        "(0-100) — never invent a number the user didn't state.",
      inputSchema: {
        action: z
          .enum(["play", "pause", "next", "previous", "current", "search", "queue", "volume"])
          .describe("Which Spotify operation to perform."),
        query: z
          .string()
          .optional()
          .describe("play/search: what to look for, e.g. 'Bohemian Rhapsody' or 'Daft Punk'."),
        searchType: z
          .enum(["track", "artist", "album", "playlist"])
          .optional()
          .describe("play/search: what kind of result to look for. Defaults to 'track'."),
        uri: z
          .string()
          .optional()
          .describe(
            "play/queue: a specific Spotify URI from a prior action='search' result — use this " +
              "instead of `query` to avoid searching again when you already know what to play.",
          ),
        volumePercent: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("volume: the exact level to set, 0-100. Required for action='volume'."),
      },
    },
    async ({ action, query, searchType, uri, volumePercent }) => {
      if (!config.spotifyClientId || !config.spotifyClientSecret || !config.spotifyRefreshToken) {
        return notConfiguredResult();
      }

      const type: SpotifySearchType = searchType ?? "track";

      try {
        if (action === "search") {
          if (!query?.trim()) return errorResult("query is required for action='search'.");
          const results = await search(config, query, type, 5);
          if (results.length === 0) return textResult(`No ${type} results found for "${query}".`);
          return textResult(results);
        }

        if (action === "play") {
          if (uri) {
            if (type === "track") await play(config, { uris: [uri] });
            else await play(config, { contextUri: uri });
            return textResult(`Playing ${uri}.`);
          }
          if (query?.trim()) {
            const results = await search(config, query, type, 1);
            if (results.length === 0) return errorResult(`No ${type} results found for "${query}".`);
            const top = results[0];
            if (type === "track") await play(config, { uris: [top.uri] });
            else await play(config, { contextUri: top.uri });
            return textResult(`Playing ${top.name}${top.artists ? " by " + top.artists : ""}.`);
          }
          await play(config);
          return textResult("Resumed playback.");
        }

        if (action === "pause") {
          await pause(config);
          return textResult("Paused.");
        }

        if (action === "next") {
          await next(config);
          return textResult("Skipped to next track.");
        }

        if (action === "previous") {
          await previous(config);
          return textResult("Skipped to previous track.");
        }

        if (action === "current") {
          const current = await getCurrentlyPlaying(config);
          if (!current) return textResult("Nothing is currently playing.");
          return textResult(current);
        }

        if (action === "queue") {
          const targetUri = uri ?? (query?.trim() ? (await search(config, query, "track", 1))[0]?.uri : undefined);
          if (!targetUri) return errorResult("Provide a query or uri for action='queue'.");
          await addToQueue(config, targetUri);
          return textResult("Added to queue.");
        }

        // action === "volume"
        if (volumePercent === undefined) return errorResult("volumePercent is required for action='volume'.");
        await setVolume(config, volumePercent);
        return textResult(`Volume set to ${volumePercent}%.`);
      } catch (e) {
        return errorResult(`spotify_control failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
