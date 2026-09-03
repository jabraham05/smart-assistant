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
  // Deliberately low, not high: arriving/leaving home is never something
  // the user needs told about via a DM to their own phone - the value here
  // is the audit trail and future goal-matching (e.g. a "spend less time
  // at my desk in the evening" goal), not a notification. Never has an
  // origin_session_id (Home Assistant has no chat session), so if this
  // were "high" it would DM-escalate on every single arrival/departure.
  "home_assistant.arrived_home": { priority: "low", notify: false },
  "home_assistant.left_home": { priority: "low", notify: false },
  // Audit-trail only - never needs to reach the user actively.
  "google_calendar.event_detected": { priority: "low", notify: false },
  // No origin_session_id is ever set for this source (a passive
  // session-write wouldn't reach the user in time for a "starting soon"
  // reminder to matter) - relies entirely on the priority:"high" +
  // no-session escalation path.
  "google_calendar.event_starting_soon": { priority: "high", notify: false },
  // No origin_session_id here either. The real "don't overdo it" cap is
  // idleReflectionMessageMinHours (see index.ts's /idle-reflection-check
  // and /idle-reflection-messaged), not this priority - "high" here just
  // means "when it IS allowed to fire, it must actually reach the user,"
  // not "fire often."
  "idle_reflection.proactive_thought": { priority: "high", notify: false },
};

export function classify(source: string, type: string): ClassificationResult {
  return RULES[`${source}.${type}`] ?? DEFAULT;
}
