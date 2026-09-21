import type { Config } from "./config.js";

export interface MemorySearchResult {
  content: string;
  role: string;
  sessionId: string;
  createdAt: string;
  score: number;
}

// Self-hosted replacement for a Honcho-dialectic-based "what do I know
// relevant to this" lookup - same automatic, no-model-decision-required
// shape, backed by our own store instead of a hosted third party (see
// the architecture plan's Phase 3). Degrades to an empty result rather
// than throwing, same "briefly-unreachable dependency shouldn't break
// the chat" pattern honcho.ts already uses for the peer-card fetch.
export async function searchMemory(config: Config, query: string, topK = 5): Promise<MemorySearchResult[]> {
  try {
    const res = await fetch(`${config.memoryEngineUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, topK }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: MemorySearchResult[] };
    return data.results ?? [];
  } catch (e) {
    console.error("memory-engine search failed:", e);
    return [];
  }
}

export async function ingestMemory(
  config: Config,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  try {
    await fetch(`${config.memoryEngineUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, role, content }),
    });
  } catch (e) {
    console.error("memory-engine ingest failed:", e);
  }
}
