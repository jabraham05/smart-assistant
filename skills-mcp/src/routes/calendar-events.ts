import type { Express } from "express";
import type { Config } from "../config.js";
import { listEvents, type CalendarEvent } from "../lib/google-calendar.js";

// Internal-only, plain REST - no LLM/MCP involved. event-bus's calendar
// poll-and-diff watcher (calendar-watch.ts) calls this instead of getting
// its own Google Calendar service-account key baked into a second Docker
// image - this service already has that auth set up (see
// lib/google-calendar.ts), same reasoning as dashboard-data.ts's own
// fetchCalendar() already reusing listEvents() in-process.
export function registerCalendarEventsRoute(app: Express, config: Config): void {
  app.get("/internal/calendar-events", async (req, res) => {
    if (!config.googleCalendarKeyFile || !config.googleCalendarId) {
      return res.json({ configured: false, events: [] });
    }

    const lookaheadHours = Number(req.query.lookaheadHours) || 24;
    const now = new Date();
    const until = new Date(now.getTime() + lookaheadHours * 60 * 60 * 1000);

    try {
      const events: CalendarEvent[] = await listEvents(config, now.toISOString(), until.toISOString(), 50);
      res.json({ configured: true, events });
    } catch (e) {
      console.error("calendar-events: fetch failed", e);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
