// Server-only: KNOWLEDGE_ENGINE_URL is the internal Compose service address,
// never sent to the browser. Mirrors the request/response shape defined in
// knowledge-engine/src/index.ts's POST /search handler exactly.

export interface KnowledgeSearchRequest {
  query: string;
  domain?: string;
  metadataFilter?: Record<string, unknown>;
  includeStale?: boolean;
  topK?: number;
}

export interface KnowledgeSearchResult {
  content: string;
  documentTitle: string;
  domain: string;
  pageNumber?: number;
  sectionPath?: string;
  heading?: string;
  score: number;
  keywordOverlapCount?: number;
  queryLexemeCount?: number;
  source?: { url?: string | null; title?: string };
}

const KNOWLEDGE_ENGINE_URL = process.env.KNOWLEDGE_ENGINE_URL ?? "http://knowledge-engine:3005";

export async function knowledgeSearch(
  req: KnowledgeSearchRequest
): Promise<{ results: KnowledgeSearchResult[] } | { error: string }> {
  const res = await fetch(`${KNOWLEDGE_ENGINE_URL}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (!res.ok) {
    return { error: typeof data?.error === "string" ? data.error : `knowledge-engine returned ${res.status}` };
  }
  return data as { results: KnowledgeSearchResult[] };
}
