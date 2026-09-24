import type { Config } from "./config.js";

// Powers the always-on "already proposed or active projects" line in
// system-prompt.ts (see index.ts's Promise.all) - lets the model recognize
// "this is the same thing I already know about" before ever calling
// project_propose, rather than relying solely on knowledge-engine's own
// blunt title-lexeme-overlap dedup check after the fact. Real gap found
// live: a project the user had already approved got proposed again days
// later because the model had zero visibility into existing project state
// unless it happened to call status_overview first - see
// docs/chat-orchestrator.md's dated entry on this.
const MAX_OPEN_PROJECTS_IN_PROMPT = 10;

export interface OpenProjectSummary {
  id: number;
  title: string;
  status: string;
}

export async function listOpenProjects(config: Config): Promise<OpenProjectSummary[]> {
  try {
    const res = await fetch(`${config.knowledgeEngineUrl}/projects`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { projects: { id: number; title: string; status: string }[] };
    return data.projects
      .filter((p) => p.status === "proposed" || p.status === "active")
      .slice(0, MAX_OPEN_PROJECTS_IN_PROMPT)
      .map((p) => ({ id: p.id, title: p.title, status: p.status }));
  } catch (e) {
    console.error("listOpenProjects failed:", e);
    return [];
  }
}

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
