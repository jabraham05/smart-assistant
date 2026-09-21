import type { EventBusEvent } from "@/types/chat";

// Server-side only, same "no client-side secrets/URLs" shape as
// honcho-client.ts - event-bus is internal-only (no published port), so
// this only ever runs from a Next.js API route, never the browser.
const EVENT_BUS_URL = process.env.EVENT_BUS_URL ?? "http://event-bus:3004";

export async function listRecentEvents(limit = 50, source?: string): Promise<EventBusEvent[]> {
  const url = new URL(`${EVENT_BUS_URL}/events`);
  url.searchParams.set("limit", String(limit));
  if (source) url.searchParams.set("source", source);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`event-bus /events failed with ${res.status}`);
  }
  const data = (await res.json()) as { events: EventBusEvent[] };
  return data.events;
}
