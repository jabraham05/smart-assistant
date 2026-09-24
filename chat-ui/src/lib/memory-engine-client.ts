import { fetchTimeoutSignal } from "./fetch-timeout";

// Server-side only, same "no client-side secrets/URLs" shape as every
// other internal-service client here. memory-engine has no published
// port and, until now, no chat-ui caller at all - this is the first.
const MEMORY_ENGINE_URL = process.env.MEMORY_ENGINE_URL ?? "http://memory-engine:3007";

export interface MemoryEntry {
  id: number;
  session_id: string;
  role: string;
  content: string;
  domain: string | null;
  task_context_id: number | null;
  created_at: string;
}

// Powers Amy Lab's Memory tab default browse view - plain recency-ordered
// list, distinct from searchMemoryEntries' relevance-ranked query mode.
export async function listMemoryEntries(options: { limit?: number; offset?: number; domain?: string } = {}): Promise<MemoryEntry[]> {
  const url = new URL(`${MEMORY_ENGINE_URL}/entries`);
  if (options.limit) url.searchParams.set("limit", String(options.limit));
  if (options.offset) url.searchParams.set("offset", String(options.offset));
  if (options.domain) url.searchParams.set("domain", options.domain);
  const res = await fetch(url, { cache: "no-store", signal: fetchTimeoutSignal() });
  if (!res.ok) {
    throw new Error(`memory-engine /entries failed with ${res.status}`);
  }
  const data = (await res.json()) as { entries: MemoryEntry[] };
  return data.entries;
}

// Mirrors memory-engine's POST /search response shape exactly (its
// index.ts maps DB rows to camelCase there) - deliberately NOT the same
// shape as MemoryEntry above, which is /entries' raw snake_case DB rows.
export interface MemorySearchResult {
  content: string;
  role: string;
  sessionId: string;
  domain: string | null;
  taskContextId: number | null;
  createdAt: string;
  score: number;
  keywordOverlapCount: number;
  queryLexemeCount: number;
}

// Wraps memory-engine's existing POST /search (the same endpoint
// chat-orchestrator's per-turn retrieval and the memory_recall tool
// already use) for Amy Lab's Memory tab search box.
export async function searchMemoryEntries(query: string, options: { domain?: string; topK?: number } = {}): Promise<MemorySearchResult[]> {
  const res = await fetch(`${MEMORY_ENGINE_URL}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, domain: options.domain, topK: options.topK }),
    signal: fetchTimeoutSignal(),
  });
  if (!res.ok) {
    throw new Error(`memory-engine /search failed with ${res.status}`);
  }
  const data = (await res.json()) as { results: MemorySearchResult[] };
  return data.results;
}
