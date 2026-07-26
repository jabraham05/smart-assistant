import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { createEvent, deleteEvent, listEvents, updateEvent } from "../lib/google-calendar.js";
import { errorResult, textResult } from "../types.js";

const isoDateTime = z
  .string()
  .describe("ISO 8601 datetime with a timezone offset, e.g. '2026-07-27T15:00:00-07:00'.");

function notConfiguredResult() {
  return errorResult(
    "Google Calendar is not configured (GOOGLE_CALENDAR_KEY_FILE / GOOGLE_CALENDAR_ID not set).",
  );
}

export function registerCalendarEvent(server: McpServer, config: Config): void {
  server.registerTool(
    "calendar_event",
    {
      title: "Calendar event",
      description:
        "Manage events on the user's Google Calendar: list, create, update, or delete, " +
        "chosen via the `action` parameter. Use action='list' for anything about what's " +
        "already scheduled — 'what's on my calendar', 'am I free at 3pm', confirming a " +
        "meeting exists — and always call action='list' first to get an event's exact " +
        "eventId before action='update' or action='delete'; never guess or construct an " +
        "eventId yourself. Use action='create' once you have a clear title and start/end " +
        "time, either stated directly or reasonably inferable — if genuinely ambiguous, ask " +
        "rather than guessing. action='update' only changes the fields you provide; omitted " +
        "fields are left as-is. action='delete' cannot be undone — confirm with the user " +
        "which event they mean first if there's any ambiguity.",
      inputSchema: {
        action: z
          .enum(["list", "create", "update", "delete"])
          .describe("Which calendar operation to perform."),
        timeMin: isoDateTime
          .optional()
          .describe("list: start of the time range to search. Omit to default to now."),
        timeMax: isoDateTime
          .optional()
          .describe("list: end of the time range to search. Omit to default to 7 days from now."),
        maxResults: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("list: maximum number of events to return. Defaults to 20."),
        eventId: z
          .string()
          .optional()
          .describe("update/delete: the event's id, from a prior action='list' call. Required for both."),
        summary: z.string().optional().describe("create: event title (required). update: new title, if changing."),
        start: isoDateTime.optional().describe("create: event start time (required). update: new start time, if changing."),
        end: isoDateTime.optional().describe("create: event end time (required). update: new end time, if changing."),
        description: z.string().optional().describe("create/update: event description/notes."),
        location: z.string().optional().describe("create/update: event location."),
      },
    },
    async ({ action, timeMin, timeMax, maxResults, eventId, summary, start, end, description, location }) => {
      if (!config.googleCalendarKeyFile || !config.googleCalendarId) return notConfiguredResult();

      try {
        if (action === "list") {
          const now = new Date();
          const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          const events = await listEvents(
            config,
            timeMin ?? now.toISOString(),
            timeMax ?? weekOut.toISOString(),
            maxResults ?? 20,
          );
          if (events.length === 0) return textResult("No events found in that range.");
          return textResult(
            events.map((e) => ({
              id: e.id,
              summary: e.summary,
              start: e.start?.dateTime ?? e.start?.date,
              end: e.end?.dateTime ?? e.end?.date,
              location: e.location,
            })),
          );
        }

        if (action === "create") {
          if (!summary?.trim()) return errorResult("summary is required for action='create'.");
          if (!start) return errorResult("start is required for action='create'.");
          if (!end) return errorResult("end is required for action='create'.");
          const event = await createEvent(config, { summary, start, end, description, location });
          return textResult({ id: event.id, summary: event.summary, htmlLink: event.htmlLink });
        }

        if (action === "update") {
          if (!eventId?.trim()) return errorResult("eventId is required for action='update'.");
          const event = await updateEvent(config, eventId, { summary, start, end, description, location });
          return textResult({ id: event.id, summary: event.summary, htmlLink: event.htmlLink });
        }

        // action === "delete"
        if (!eventId?.trim()) return errorResult("eventId is required for action='delete'.");
        await deleteEvent(config, eventId);
        return textResult(`Event ${eventId} deleted.`);
      } catch (e) {
        return errorResult(`calendar_event failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
