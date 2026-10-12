import type { Config } from "../config.js";
import { getGoogleAccessToken } from "./google-oauth.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

// Real incident (2026-10-12): the Google Cloud project backing the old
// service-account key was deleted - every call failed with a 403
// "Project #... has been deleted", unrelated to anything in this file.
// Migrated off service-account auth entirely (it also couldn't have
// covered the Drive access being added alongside this - a service
// account only sees resources explicitly shared with its own robot
// email, which doesn't scale to "the user's own Drive"). Now uses the
// same user-delegated OAuth2 flow google-drive.ts and scripts/
// google-auth.mjs use, via the shared cached-token helper in
// google-oauth.ts.
async function calendarFetch(
  config: Config,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  if (!config.googleCalendarId) {
    throw new Error("Google Calendar is not configured (GOOGLE_CALENDAR_ID not set).");
  }
  const accessToken = await getGoogleAccessToken(config);

  const res = await fetch(`${CALENDAR_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Calendar API failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
}

export async function listEvents(
  config: Config,
  timeMin: string,
  timeMax: string,
  maxResults: number,
): Promise<CalendarEvent[]> {
  const calId = encodeURIComponent(config.googleCalendarId!);
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const data = (await calendarFetch(config, `/calendars/${calId}/events?${params}`)) as {
    items?: CalendarEvent[];
  };
  return data.items ?? [];
}

export async function createEvent(
  config: Config,
  event: { summary: string; start: string; end: string; description?: string; location?: string },
): Promise<CalendarEvent> {
  const calId = encodeURIComponent(config.googleCalendarId!);
  return (await calendarFetch(config, `/calendars/${calId}/events`, {
    method: "POST",
    body: JSON.stringify({
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
    }),
  })) as CalendarEvent;
}

export async function updateEvent(
  config: Config,
  eventId: string,
  patch: { summary?: string; start?: string; end?: string; description?: string; location?: string },
): Promise<CalendarEvent> {
  const calId = encodeURIComponent(config.googleCalendarId!);
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.start !== undefined) body.start = { dateTime: patch.start };
  if (patch.end !== undefined) body.end = { dateTime: patch.end };

  return (await calendarFetch(config, `/calendars/${calId}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })) as CalendarEvent;
}

export async function deleteEvent(config: Config, eventId: string): Promise<void> {
  const calId = encodeURIComponent(config.googleCalendarId!);
  await calendarFetch(config, `/calendars/${calId}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
}
