import type { Config } from "../config.js";

export interface MemorySearchResult {
  content: string;
  role: string;
  sessionId: string;
  domain: string | null;
  taskContextId: number | null;
  createdAt: string;
  score: number;
}

// Same self-hosted store chat-orchestrator's automatic cross-conversation
// retrieval uses (see chat-orchestrator/src/memory-engine-client.ts) -
// this is the manual path, for when the model explicitly decides
// mid-conversation it needs to check something further. Both share one
// backend rather than memory_recall separately depending on Honcho's
// dialectic API. No LLM synthesis step - deterministic classification-
// derived domain tagging + hybrid RRF ranking surface the right raw
// snippets without a summarization call. taskContextId (Phase 3b) lets a
// recall be scoped to one task's own timeline instead of the whole
// global history - the model can pass it when the open-tasks list
// already shown to it makes clear which task a question is about.
export async function searchMemory(
  config: Config,
  query: string,
  options: { topK?: number; taskContextId?: number } = {},
): Promise<MemorySearchResult[]> {
  const res = await fetch(`${config.memoryEngineUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, topK: options.topK ?? 5, taskContextId: options.taskContextId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`memory-engine search failed: ${res.status} ${body}`.trim());
  }
  const data = (await res.json()) as { results?: MemorySearchResult[] };
  return data.results ?? [];
}

export interface ForgottenMemoryEntry {
  id: number;
  content: string;
  sessionId: string;
  createdAt: string;
}

// memory_forget's backend - retags Amy's own matching past replies as
// 'ungrounded' (never deletes) so searchMemory's grounding filter excludes
// them from now on. See memory-engine/src/db.ts's own comment on
// hybridSearchMemory for the incident this closes: an invented reply gets
// tagged 'ungrounded' correctly when zero tools were called, but a reply
// that called some tool and *also* embellished a specific claim beyond
// what that tool returned gets tagged 'tool_verified' regardless - this
// is the explicit remedy for that gap, triggered by the user, not a
// heuristic trying to catch it automatically.
export async function forgetMemory(config: Config, query: string): Promise<ForgottenMemoryEntry[]> {
  const res = await fetch(`${config.memoryEngineUrl}/entries/forget`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`memory-engine forget failed: ${res.status} ${body}`.trim());
  }
  const data = (await res.json()) as { matches?: ForgottenMemoryEntry[] };
  return data.matches ?? [];
}
