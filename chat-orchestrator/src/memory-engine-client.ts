import type { Config } from "./config.js";

export interface MemorySearchResult {
  content: string;
  role: string;
  sessionId: string;
  domain: string | null;
  taskContextId: number | null;
  createdAt: string;
  score: number;
}

// Self-hosted replacement for a Honcho-dialectic-based "what do I know
// relevant to this" lookup - same automatic, no-model-decision-required
// shape, backed by our own store instead of a hosted third party (see
// the architecture plan's Phase 3). No LLM synthesis step - deliberately
// deterministic end to end (classification-derived domain tagging +
// hybrid RRF ranking do the work of surfacing the right raw snippets,
// no summarization call needed on top). Degrades to an empty result
// rather than throwing, same "briefly-unreachable dependency shouldn't
// break the chat" pattern honcho.ts already uses for the peer-card fetch.
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
  domain?: string,
  taskContextId?: number,
): Promise<void> {
  try {
    await fetch(`${config.memoryEngineUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, role, content, domain, taskContextId }),
    });
  } catch (e) {
    console.error("memory-engine ingest failed:", e);
  }
}
