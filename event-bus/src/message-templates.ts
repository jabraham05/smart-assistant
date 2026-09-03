import type { EventRow } from "./db.js";

// Plain per-(source,type) templates, no LLM - same house style as
// classify.ts. Used for both the existing notifySession path and the new
// notifyOwnerDirect escalation path in index.ts, so a real event always
// gets a real message instead of the generic fallback below.

export function buildEventMessage(event: EventRow): string {
  const payload = event.payload as Record<string, unknown>;

  switch (`${event.source}.${event.type}`) {
    case "coding_orchestrator.task_needs_review": {
      const taskDescription = payload.taskDescription as string | undefined;
      const reviewerReason = payload.reviewerReason as string | undefined;
      const attemptCount = payload.attemptCount as number | undefined;
      return (
        `A coding task didn't pass review after ${attemptCount ?? "several"} attempt(s): ` +
        `${taskDescription ?? "(no description)"}. ${reviewerReason || ""} ` +
        `(started outside a chat session — check the coding_proposals table for details.)`
      ).trim();
    }
    case "coding_orchestrator.task_resource_limit": {
      const taskDescription = payload.taskDescription as string | undefined;
      return (
        `A coding task stopped early — it hit its command limit before finishing: ` +
        `${taskDescription ?? "(no description)"}. ` +
        `(started outside a chat session — check the coding_proposals table for what's there so far.)`
      );
    }
    case "google_calendar.event_starting_soon": {
      const summary = payload.summary as string | undefined;
      const start = payload.start as string | undefined;
      return `Starting soon: ${summary ?? "(untitled event)"}${start ? ` at ${start}` : ""}.`;
    }
    case "idle_reflection.proactive_thought": {
      // The model already wrote the user-facing text - no further
      // templating needed, just surface it directly.
      return (payload.message as string | undefined) ?? "Amy had a thought but didn't include a message.";
    }
    default:
      return `Event: ${event.type} (from ${event.source}).`;
  }
}
