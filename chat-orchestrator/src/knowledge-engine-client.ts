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

// Promotes a classifier-extracted memorable item (fact/preference/decision/
// learning) or a behavior-feedback capture into a durable `entities` row -
// fire-and-forget, same pattern as enqueueResearchTopic above. Dedup/
// validation all happen inside knowledge-engine's own POST /entities; this
// is a thin, fail-silent client.
export async function createEntityFromChat(
  config: Config,
  itemType: string,
  content: string,
  options?: { sessionId?: string },
): Promise<void> {
  try {
    await fetch(`${config.knowledgeEngineUrl}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: itemType,
        name: content.slice(0, 80),
        description: content,
        sourceTable: "chat",
        sourceId: options?.sessionId,
      }),
    });
  } catch (e) {
    console.error("knowledge-engine entity create failed:", e);
  }
}
