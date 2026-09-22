import type { Config } from "./config.js";

// Fire-and-forget, mirrors the old "Publish Message Event" node and every
// other service's own event-bus publish (e.g. coding-orchestrator's
// notify.ts) - an unreachable event-bus must never affect the real chat
// path, so callers should never await this without a .catch.
export async function publishMessageEvent(config: Config, sessionId: string, chatInput: string): Promise<void> {
  await fetch(`${config.eventBusUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "chat",
      type: "message_received",
      payload: { chatInput },
      originSessionId: sessionId,
    }),
  });
}

// Real equivalent of the old n8n Chat workflow's "Publish Classification
// Event" node - gives the eval harness (scripts/eval-harness.mjs) and the
// ops dashboard a queryable record of what each turn actually classified
// to, since chat-orchestrator itself never returns that to the caller.
// Fire-and-forget like publishMessageEvent above, for the same reason.
export async function publishClassificationEvent(
  config: Config,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await fetch(`${config.eventBusUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "chat",
      type: "message_classified",
      payload,
      originSessionId: sessionId,
    }),
  });
}

// First building block of the self-improvement loop discussed alongside
// the /amy projects feature (see docs/chat-orchestrator.md's dated entry):
// just capturing the raw signal reliably, with no investigation/experiment
// machinery yet. Deliberately reuses the plain events table rather than a
// new one - this is exactly the "raw, append-only record" tier, same
// reasoning as every other publish* function here. Fire-and-forget, same
// reason as the others.
export async function publishBehaviorFeedbackEvent(
  config: Config,
  sessionId: string,
  feedback: { category: string; note: string },
): Promise<void> {
  await fetch(`${config.eventBusUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "chat",
      type: "behavior_feedback",
      payload: feedback,
      originSessionId: sessionId,
    }),
  });
}
