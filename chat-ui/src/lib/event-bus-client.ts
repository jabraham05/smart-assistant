import type { EventBusEvent, HomeSummary, TaskContext } from "@/types/chat";

// Server-side only, same "no client-side secrets/URLs" shape as
// honcho-client.ts - event-bus is internal-only (no published port), so
// this only ever runs from a Next.js API route, never the browser.
const EVENT_BUS_URL = process.env.EVENT_BUS_URL ?? "http://event-bus:3004";

export async function listRecentEvents(
  limit = 50,
  source?: string,
  type?: string,
  originSessionId?: string,
): Promise<EventBusEvent[]> {
  const url = new URL(`${EVENT_BUS_URL}/events`);
  url.searchParams.set("limit", String(limit));
  if (source) url.searchParams.set("source", source);
  if (type) url.searchParams.set("type", type);
  if (originSessionId) url.searchParams.set("originSessionId", originSessionId);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`event-bus /events failed with ${res.status}`);
  }
  const data = (await res.json()) as { events: EventBusEvent[] };
  return data.events;
}

export async function postEvent(input: {
  source: string;
  type: string;
  payload?: Record<string, unknown>;
  originSessionId?: string;
}): Promise<void> {
  const res = await fetch(`${EVENT_BUS_URL}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`event-bus POST /events failed with ${res.status}`);
  }
}

export async function getHomeSummary(): Promise<HomeSummary> {
  const res = await fetch(`${EVENT_BUS_URL}/home-summary`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`event-bus /home-summary failed with ${res.status}`);
  }
  return res.json();
}

// Home dashboard's editable todos list - a task_context the user typed in
// directly rather than one Amy created while working (see
// postgres/init/19-add-task-context-source.sql's `source` column).
export async function createTodo(objective: string): Promise<TaskContext> {
  const res = await fetch(`${EVENT_BUS_URL}/task-contexts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objective, source: "user" }),
  });
  if (!res.ok) {
    throw new Error(`event-bus POST /task-contexts failed with ${res.status}`);
  }
  return res.json();
}

export async function updateTodo(
  id: number,
  fields: Partial<Pick<TaskContext, "objective" | "status">>,
): Promise<TaskContext> {
  const res = await fetch(`${EVENT_BUS_URL}/task-contexts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    throw new Error(`event-bus PATCH /task-contexts/${id} failed with ${res.status}`);
  }
  return res.json();
}
