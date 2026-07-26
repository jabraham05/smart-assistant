import { GoogleAuth } from "google-auth-library";
import type { Config } from "../config.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

// Cached at module scope, not per-request: GoogleAuth internally caches and
// refreshes the minted access token on the same client instance, so reusing
// one client across calls avoids re-authenticating on every tool call.
let cachedAuth: GoogleAuth | null = null;

function getAuth(config: Config): GoogleAuth {
  if (!config.googleCalendarKeyFile) {
    throw new Error(
      "Google Calendar is not configured (GOOGLE_CALENDAR_KEY_FILE not set).",
    );
  }
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      keyFile: config.googleCalendarKeyFile,
      scopes: SCOPES,
    });
  }
  return cachedAuth;
}

async function calendarFetch(
  config: Config,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  if (!config.googleCalendarId) {
    throw new Error("Google Calendar is not configured (GOOGLE_CALENDAR_ID not set).");
  }
  const auth = getAuth(config);
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken.token) {
    throw new Error("Failed to obtain a Google Calendar access token.");
  }

  const res = await fetch(`${CALENDAR_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken.token}`,
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
