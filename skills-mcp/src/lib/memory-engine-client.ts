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
