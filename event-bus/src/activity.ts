import type { EventRow } from "./db.js";

// Which (source, type) pairs are "digest-worthy" for GET /home-activity -
// the curated, glanceable feed (research done / project created / task
// updated), as opposed to the full unscoped `events` firehose (still
// available via GET /events for debugging/the Chat sidebar). Same key
// format as classify.ts's RULES so the two stay easy to cross-reference.
// Goal progress is a separate category entirely - it lives in
// goal_progress_log, not `events` (see db.ts's listRecentGoalProgress),
// so it isn't listed here.
export const DIGEST_ALLOWLIST = [
  "research.research_completed",
  "research.research_completed_awaiting_digest",
  "project.project_created",
  "task_context.task_context_created",
  "task_context.task_context_updated",
];

// One human-readable line per digest-worthy event, computed server-side so
// every consumer (today: chat-ui's Home page) renders the same text
// without re-deriving it from a raw payload shape. Deliberately a plain
// switch, not an LLM call - same reasoning as classify.ts.
export function summarizeEvent(event: Pick<EventRow, "source" | "type" | "payload">): string {
  const payload = event.payload as Record<string, unknown>;
  switch (`${event.source}.${event.type}`) {
    case "research.research_completed":
    case "research.research_completed_awaiting_digest": {
      const topic = typeof payload.topic === "string" ? payload.topic : "a topic";
      return payload.failed ? `Research on "${topic}" didn't finish successfully.` : `Finished researching "${topic}".`;
    }
    case "project.project_created": {
      const title = typeof payload.title === "string" ? payload.title : "a project";
      return `Project "${title}" created.`;
    }
    case "task_context.task_context_created": {
      const objective = typeof payload.objective === "string" ? payload.objective : "a task";
      return `Task "${objective}" created.`;
    }
    case "task_context.task_context_updated": {
      const objective = typeof payload.objective === "string" ? payload.objective : "a task";
      const status = typeof payload.status === "string" ? payload.status : "updated";
      return `Task "${objective}" marked ${status.replace(/_/g, " ")}.`;
    }
    default:
      return `${event.source} ${event.type.replace(/_/g, " ")}`;
  }
}
