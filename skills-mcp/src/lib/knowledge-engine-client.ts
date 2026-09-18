import type { Config } from "../config.js";

// Direct fetch to knowledge-engine, not proxied through an n8n webhook -
// same "always-on internal infra, no legacy webhook URL to preserve"
// reasoning as goal_manage -> event-bus (see lib/event-bus-workflow.ts's
// own comment). Replaces lib/research-workflow.ts, which called
// research_pipeline's three n8n webhooks.

export interface KnowledgeSearchResult {
  content: string;
  documentTitle: string | null;
  domain: string | null;
  pageNumber: number | null;
  sectionPath: string | null;
  heading: string | null;
  score: number;
  source: { url: string | null; title: string | null };
}

async function jsonOrThrow<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

export async function knowledgeSearch(
  config: Config,
  query: string,
  options: { domain?: string; topK?: number } = {},
): Promise<KnowledgeSearchResult[]> {
  const res = await fetch(`${config.knowledgeEngineUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, domain: options.domain, topK: options.topK }),
  });
  const data = await jsonOrThrow<{ results: KnowledgeSearchResult[] }>(res, "Knowledge search");
  return data.results;
}

export interface KnowledgeIngestResult {
  documentId: number;
  sourceId: number;
  chunkCount: number;
}

export async function knowledgeIngestUrl(
  config: Config,
  url: string,
  options: { domain?: string; title?: string } = {},
): Promise<KnowledgeIngestResult> {
  const res = await fetch(`${config.knowledgeEngineUrl}/documents/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceType: "url", url, domain: options.domain, title: options.title, triggerSource: "chat" }),
  });
  return jsonOrThrow<KnowledgeIngestResult>(res, "Knowledge ingest");
}

export interface ResearchStartResult {
  route: { source: "knowledge" | "web"; reason: string };
  knowledgeResults: KnowledgeSearchResult[];
  sessionId?: number;
  status?: string;
}

// POST /research's fast half always returns quickly, even for a web
// escalation (see knowledge-engine's engine/research.ts) - it acks with a
// sessionId and keeps working in the background, so this call is safe to
// await directly without risking a long-hanging MCP tool call.
export async function startResearch(
  config: Config,
  query: string,
  options: { domain?: string; originSessionId?: string } = {},
): Promise<ResearchStartResult> {
  const res = await fetch(`${config.knowledgeEngineUrl}/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, domain: options.domain, triggerSource: "chat", originSessionId: options.originSessionId }),
  });
  return jsonOrThrow<ResearchStartResult>(res, "Research start");
}

export interface ResearchStatus {
  found: boolean;
  status?: string;
  topic?: string;
  sessionId?: number;
  documentId?: number;
}

export async function getResearchStatus(config: Config, originSessionId: string): Promise<ResearchStatus> {
  const url = new URL(`${config.knowledgeEngineUrl}/research/status`);
  url.searchParams.set("sessionId", originSessionId);
  const res = await fetch(url.toString());
  return jsonOrThrow<ResearchStatus>(res, "Research status lookup");
}
