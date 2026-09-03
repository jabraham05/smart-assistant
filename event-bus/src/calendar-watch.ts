import type { Config } from "./config.js";
import * as db from "./db.js";
import { ingestEvent } from "./ingest.js";

interface CalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
}

interface CalendarEventsResponse {
  configured: boolean;
  events: CalendarEvent[];
}

// Deterministic poll-and-diff, no LLM - same house style as classify.ts.
// Calls skills-mcp instead of talking to Google Calendar directly, reusing
// its already-baked-in service-account auth (see
// skills-mcp/src/routes/calendar-events.ts) rather than duplicating that
// key into this image too.
export async function pollCalendar(config: Config): Promise<{ detected: number; reminded: number }> {
  const res = await fetch(
    `${config.skillsMcpUrl}/internal/calendar-events?lookaheadHours=${config.calendarPollLookaheadHours}`,
  );
  if (!res.ok) {
    throw new Error(`calendar-events fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as CalendarEventsResponse;

  let detected = 0;
  let reminded = 0;

  if (data.configured) {
    for (const event of data.events) {
      const startTime = event.start?.dateTime ?? event.start?.date ?? null;
      const existing = await db.getCalendarWatcherState(config, event.id);

      if (!existing) {
        await db.insertCalendarWatcherState(config, {
          eventId: event.id,
          summary: event.summary ?? null,
          startTime,
        });
        await ingestEvent(config, {
          source: "google_calendar",
          type: "event_detected",
          payload: { eventId: event.id, summary: event.summary, start: startTime },
        });
        detected++;
        continue;
      }

      if (!existing.reminded_at && startTime) {
        const minutesUntilStart = (new Date(startTime).getTime() - Date.now()) / 60_000;
        if (minutesUntilStart > 0 && minutesUntilStart <= config.calendarReminderLeadMinutes) {
          await ingestEvent(config, {
            source: "google_calendar",
            type: "event_starting_soon",
            payload: { eventId: event.id, summary: event.summary, start: startTime },
          });
          await db.markCalendarReminded(config, event.id);
          reminded++;
        }
      }
    }
  }

  await db.pruneOldCalendarWatcherState(config);

  return { detected, reminded };
}
