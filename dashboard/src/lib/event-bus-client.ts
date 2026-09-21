// Server-only: EVENT_BUS_URL is the internal Compose service address.
// Reuses event-bus's own endpoints/logic for goals and task contexts rather
// than re-deriving their derivation logic in raw SQL here.
const EVENT_BUS_URL = process.env.EVENT_BUS_URL ?? "http://event-bus:3004";

export async function listActiveGoals() {
  const res = await fetch(`${EVENT_BUS_URL}/goals?status=active`);
  if (!res.ok) throw new Error(`event-bus /goals returned ${res.status}`);
  const data = await res.json();
  return data.goals as Array<{ id: number; title: string; status: string; created_at: string }>;
}

export async function listOpenTaskContexts() {
  const res = await fetch(`${EVENT_BUS_URL}/task-contexts?status=open`);
  if (!res.ok) throw new Error(`event-bus /task-contexts returned ${res.status}`);
  const data = await res.json();
  return data.taskContexts as Array<{ id: number; objective: string; status: string; created_at: string }>;
}
