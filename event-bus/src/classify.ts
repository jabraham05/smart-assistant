// Deliberately a plain lookup table, not an LLM call. This session found
// two separate incidents of the local model failing to reliably hold
// instructions or converge on a moderately complex task - classification
// is not a place to add a third dependency on that same reasoning core.
// Unmatched (source, type) pairs fall back to DEFAULT rather than being
// rejected; an unrecognized event is still recorded (see index.ts), just
// treated conservatively.

export interface ClassificationResult {
  priority: "low" | "normal" | "high";
  notify: boolean;
}

const DEFAULT: ClassificationResult = { priority: "normal", notify: false };

// All three v1 sources default to notify:false. coding-orchestrator already
// has its own working notifyOrigin() call for task completion - Event Bus
// logging the same thing again would double the message, not add value.
// Discord DMs are already answered synchronously in-channel. Dashboard
// control changes are informational only. The only thing Event Bus itself
// notifies on in v1 is the Goals stale-nudge (see index.ts's
// /goals/nudge-check) - a deliberately conservative start, not a
// general-purpose "everything pings you" firehose.
//
// `priority: "high"` has a real behavioral consequence beyond being stored
// on the row: index.ts escalates any high-priority event with no
// origin_session_id into a direct Discord DM (see discord-notify.ts),
// since that's the one case with no existing notification path at all
// (not a session to reply into, not covered by a source's own notify
// call). Don't mark something "high" casually - it means "the user must
// find out about this even if nobody's chatting with Amy right now."
const RULES: Record<string, ClassificationResult> = {
  "coding_orchestrator.task_completed": { priority: "normal", notify: false },
  "coding_orchestrator.task_resource_limit": { priority: "high", notify: false },
  "coding_orchestrator.task_needs_review": { priority: "high", notify: false },
  "discord.dm_received": { priority: "normal", notify: false },
  "pi_dashboard.control_changed": { priority: "low", notify: false },
};

export function classify(source: string, type: string): ClassificationResult {
  return RULES[`${source}.${type}`] ?? DEFAULT;
}
