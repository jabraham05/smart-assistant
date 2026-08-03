import type { Express } from "express";
import type { Config } from "../config.js";
import { play, pause, next, previous } from "../lib/spotify.js";

const ACTIONS: Record<string, (config: Config) => Promise<void>> = {
  play: (config) => play(config),
  pause,
  next,
  previous,
};

// Plain internal REST route, no LLM/MCP involved — the Pi's play/pause/
// skip buttons hit this via a dedicated n8n webhook (the Pi can only reach
// n8n's published port on the LAN, never skills-mcp directly) so a literal
// button tap doesn't pay a model round-trip.
export function registerSpotifyActionRoute(app: Express, config: Config): void {
  app.post("/internal/spotify-action", async (req, res) => {
    const action = typeof req.body?.action === "string" ? req.body.action : undefined;
    const handler = action ? ACTIONS[action] : undefined;
    if (!handler) {
      res.status(400).json({ error: `Unknown action '${action}'` });
      return;
    }
    try {
      await handler(config);
      res.sendStatus(202);
    } catch (e) {
      console.error("spotify-action failed", e);
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
