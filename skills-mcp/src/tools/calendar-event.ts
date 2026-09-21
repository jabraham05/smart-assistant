import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { createEvent, deleteEvent, listEvents, updateEvent, type CalendarEvent } from "../lib/google-calendar.js";
import { errorResult, textResult } from "../types.js";
import { registerVerifier, verifyToolResult } from "../lib/verify-tool-result.js";
import { logToMostRecentOpenTask } from "../lib/event-bus-workflow.js";

// Takes homeTimezone so the description can state a concrete, unambiguous
// offset - observed directly: given only an abstract example, the model
// created a "3pm" event using 'Z' (UTC) instead of the user's actual local
// offset, landing it 7 hours off from what was asked.
function isoDateTime(homeTimezone: string) {
  return z
    .string()
    .describe(
      `ISO 8601 datetime with a timezone offset, e.g. '2026-07-27T15:00:00-07:00'. This ` +
        `user's local timezone is ${homeTimezone} — when the user gives a local/wall-clock ` +
        `time ("3pm", "tomorrow morning") without naming a timezone, use that offset. Only ` +
        `use 'Z'/UTC if the user explicitly says UTC or GMT.`,
    );
}

// Deterministic safety net, independent of whether the model's context
// actually included the real current date (observed directly: it
// doesn't always, even with that date injected into the system prompt -
// intermittent and not yet root-caused, but a wrong calendar entry is a
// real-world consequence worth guarding against regardless of why the
// model got there). Wide window (-1yr, +2yr) so legitimate retroactive
// logging or far-out planning still works; only catches dates that are
// wildly implausible, matching the actual observed failure (landing on
// a ~2-3 year-old placeholder date instead of a real one).
function implausibleDateError(iso: string, label: "start" | "end"): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return `${label} ("${iso}") is not a valid date/time.`;
  const now = new Date();
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  if (parsed.getTime() < now.getTime() - oneYearMs || parsed.getTime() > now.getTime() + 2 * oneYearMs) {
    return (
      `${label} ("${iso}") looks wrong — that's ` +
      `${Math.round(Math.abs(parsed.getTime() - now.getTime()) / oneYearMs)} year(s) from now. ` +
      `The actual current date/time is ${now.toISOString()}. Recompute the date relative to that and try again.`
    );
  }
  return null;
}

// Deterministic post-call verification, distinct from implausibleDateError/
// weekdayMismatchError above (those catch bad input before the call; this
// catches a bad *result* after it - e.g. Google silently normalizing or
// rejecting something the pre-call checks couldn't have caught). Registered
// once at module load, called from create/update below right before they
// decide what to return.
registerVerifier("calendar_event", (args, result) => {
  const a = args as { action?: string; summary?: string; start?: string; end?: string };
  if (a.action !== "create" && a.action !== "update") return { ok: true };
  const r = result as CalendarEvent;
  if (!r.id) return { ok: false, reason: "Google did not return an event id." };
  if (a.summary && r.summary !== a.summary) {
    return { ok: false, reason: `Requested title "${a.summary}" but Google returned "${r.summary}".` };
  }
  if (a.start && r.start?.dateTime && new Date(a.start).getTime() !== new Date(r.start.dateTime).getTime()) {
    return { ok: false, reason: `Requested start ${a.start} but Google returned ${r.start.dateTime}.` };
  }
  if (a.end && r.end?.dateTime && new Date(a.end).getTime() !== new Date(r.end.dateTime).getTime()) {
    return { ok: false, reason: `Requested end ${a.end} but Google returned ${r.end.dateTime}.` };
  }
  return { ok: true };
});

function notConfiguredResult() {
  return errorResult(
    "Google Calendar is not configured (GOOGLE_CALENDAR_KEY_FILE / GOOGLE_CALENDAR_ID not set).",
  );
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Cheap defense-in-depth, same "don't trust the model's own arithmetic"
// reasoning as implausibleDateError above - this catches the specific
// real failure observed live: a title naming a weekday ("Resident Evil
// Wednesday") landing on a start date that's actually a different
// weekday, because the model computed "this Wednesday" wrong even with
// calculate's resolve_date action available. Deliberately only checks a
// weekday literally named in the title - it can't invent a cross-check
// where the title gives no signal at all, that's what calculate's
// resolve_date action is for. Calendar dates have a fixed weekday
// regardless of timezone, so parsing just the date portion as UTC
// midnight is always correct here, no offset math needed.
export function weekdayMismatchError(summary: string | undefined, startIso: string): string | null {
  if (!summary) return null;
  const lower = summary.toLowerCase();
  const namedIndex = WEEKDAY_NAMES.findIndex((name) => new RegExp(`\\b${name}\\b`).test(lower));
  if (namedIndex === -1) return null;

  const datePart = startIso.slice(0, 10);
  const actualIndex = new Date(`${datePart}T00:00:00Z`).getUTCDay();
  if (Number.isNaN(actualIndex) || actualIndex === namedIndex) return null;

  const actualName = WEEKDAY_NAMES[actualIndex];
  const capitalized = actualName[0].toUpperCase() + actualName.slice(1);
  return (
    `The title "${summary}" says ${WEEKDAY_NAMES[namedIndex]}, but ${datePart} is actually a ` +
    `${capitalized}. Recompute the date (call calculate's resolve_date action) and try again.`
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
        "rather than guessing. For ANY relative date/time reference in what the user said " +
        "('this Wednesday', 'next Friday', 'in 3 days', 'tomorrow at 6pm') — call calculate's " +
        "resolve_date action first and use its exact result for start/end. Never compute a " +
        "relative date yourself; language models are unreliable at day-of-week arithmetic, " +
        "the same way they are at regular arithmetic. action='update' only changes the fields " +
        "you provide; omitted fields are left as-is. action='delete' cannot be undone — " +
        "confirm with the user which event they mean first if there's any ambiguity.",
      inputSchema: {
        action: z
          .enum(["list", "create", "update", "delete"])
          .describe("Which calendar operation to perform."),
        timeMin: isoDateTime(config.homeTimezone)
          .optional()
          .describe("list: start of the time range to search. Omit to default to now."),
        timeMax: isoDateTime(config.homeTimezone)
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
        start: isoDateTime(config.homeTimezone).optional().describe("create: event start time (required). update: new start time, if changing."),
        end: isoDateTime(config.homeTimezone).optional().describe("create: event end time (required). update: new end time, if changing."),
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
          const startErr = implausibleDateError(start, "start");
          if (startErr) return errorResult(startErr);
          const endErr = implausibleDateError(end, "end");
          if (endErr) return errorResult(endErr);
          const weekdayErr = weekdayMismatchError(summary, start);
          if (weekdayErr) return errorResult(weekdayErr);
          const event = await createEvent(config, { summary, start, end, description, location });
          const verification = verifyToolResult("calendar_event", { action, summary, start, end }, event);
          logToMostRecentOpenTask(
            config,
            verification.ok
              ? `calendar_event create verified: "${event.summary}" (${event.id})`
              : `calendar_event create FAILED verification: ${verification.reason}`,
          ).catch(() => {});
          if (!verification.ok) {
            return errorResult(`Event was created but didn't verify: ${verification.reason} Check the calendar directly.`);
          }
          return textResult({ id: event.id, summary: event.summary, htmlLink: event.htmlLink });
        }

        if (action === "update") {
          if (!eventId?.trim()) return errorResult("eventId is required for action='update'.");
          if (start) {
            const startErr = implausibleDateError(start, "start");
            if (startErr) return errorResult(startErr);
          }
          if (end) {
            const endErr = implausibleDateError(end, "end");
            if (endErr) return errorResult(endErr);
          }
          if (start) {
            const weekdayErr = weekdayMismatchError(summary, start);
            if (weekdayErr) return errorResult(weekdayErr);
          }
          const event = await updateEvent(config, eventId, { summary, start, end, description, location });
          const verification = verifyToolResult("calendar_event", { action, summary, start, end }, event);
          logToMostRecentOpenTask(
            config,
            verification.ok
              ? `calendar_event update verified: "${event.summary}" (${event.id})`
              : `calendar_event update FAILED verification: ${verification.reason}`,
          ).catch(() => {});
          if (!verification.ok) {
            return errorResult(`Event was updated but didn't verify: ${verification.reason} Check the calendar directly.`);
          }
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
