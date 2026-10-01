import type { Config } from "./config.js";

export interface MemorySearchResult {
  content: string;
  role: string;
  sessionId: string;
  domain: string | null;
  taskContextId: number | null;
  createdAt: string;
  score: number;
  // See memory-engine's hybridSearchMemory/knowledge-engine's router.ts:
  // a recency-boosted RRF score alone can't tell a genuine match from an
  // unrelated "best of a bad bunch" - isRelevantMemory below also checks
  // real lexeme overlap with the query.
  keywordOverlapCount: number;
  queryLexemeCount: number;
  // 'tool_verified' | 'user_stated' | 'ungrounded' - see safety-net.ts's
  // classifyMemoryGrounding. Defaults to the conservative 'ungrounded' if
  // memory-engine ever omits it (shouldn't happen post-migration, but
  // never trust-by-default on a missing field).
  grounding: string;
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
    return (data.results ?? []).map((r) => ({ ...r, grounding: r.grounding ?? "ungrounded" }));
  } catch (e) {
    console.error("memory-engine search failed:", e);
    return [];
  }
}

// Same two-signal gate as knowledge-engine's router.ts decideRoute(), for
// the same reason: a recency-boosted RRF score alone can't tell a genuine
// match from an unrelated "best of a bad bunch" result that only ranked
// because nothing better existed for this query. Deliberately a plain
// threshold check, not an LLM call - same "no model in the classification
// path" reasoning as classify.ts/decideRoute. Skips the overlap check
// entirely when the query itself has no significant lexemes, same as
// decideRoute - there's no real signal to check in that case.
export function isRelevantMemory(result: MemorySearchResult, minScore: number, minKeywordOverlap: number): boolean {
  if (result.score < minScore) return false;
  if (result.queryLexemeCount > 0 && result.keywordOverlapCount < minKeywordOverlap) return false;
  return true;
}

export async function ingestMemory(
  config: Config,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  domain?: string,
  taskContextId?: number,
  grounding: string = "ungrounded",
): Promise<void> {
  try {
    await fetch(`${config.memoryEngineUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, role, content, domain, taskContextId, grounding }),
    });
  } catch (e) {
    console.error("memory-engine ingest failed:", e);
  }
}
