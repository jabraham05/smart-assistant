import type { Config } from "./config.js";

// The self-learning research queue's write path from chat's side (see the
// architecture plan's "Self-Learning Research Queue" and
// docs/chat-orchestrator.md's Coordinator section) - called fire-and-forget
// whenever classify-tools.ts's knowledgeGapTopic is non-null, same
// never-block-the-reply pattern memory-engine-client.ts's ingestMemory
// already uses. Dedup/already-known/queue-depth gating all happen inside
// knowledge-engine's own enqueueTopic - this is a thin, fail-silent client.
export async function enqueueResearchTopic(
  config: Config,
  topic: string,
  options?: { domain?: string; sessionId?: string },
): Promise<void> {
  try {
    await fetch(`${config.knowledgeEngineUrl}/research-queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        domain: options?.domain,
        originSessionId: options?.sessionId,
        triggerSource: "chat",
      }),
    });
  } catch (e) {
    console.error("knowledge-engine research-queue enqueue failed:", e);
  }
}
