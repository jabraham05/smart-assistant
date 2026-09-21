import type { Config } from "../config.js";

export interface MemorySearchResult {
  content: string;
  role: string;
  sessionId: string;
  createdAt: string;
  score: number;
}

// Same self-hosted store chat-orchestrator's automatic cross-conversation
// retrieval uses (see chat-orchestrator/src/memory-engine-client.ts) -
// this is the manual path, for when the model explicitly decides
// mid-conversation it needs to check something further. Both share one
// backend rather than memory_recall separately depending on Honcho's
// dialectic API.
export async function searchMemory(config: Config, query: string, topK = 5): Promise<MemorySearchResult[]> {
  const res = await fetch(`${config.memoryEngineUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, topK }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`memory-engine search failed: ${res.status} ${body}`.trim());
  }
  const data = (await res.json()) as { results?: MemorySearchResult[] };
  return data.results ?? [];
}
