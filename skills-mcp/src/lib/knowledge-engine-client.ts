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
  options: { domain?: string; originSessionId?: string; deferNotify?: boolean } = {},
): Promise<ResearchStartResult> {
  const res = await fetch(`${config.knowledgeEngineUrl}/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      domain: options.domain,
      triggerSource: "chat",
      originSessionId: options.originSessionId,
      deferNotify: options.deferNotify,
    }),
  });
  return jsonOrThrow<ResearchStartResult>(res, "Research start");
}

export interface ResearchStatus {
  found: boolean;
  status?: string;
  topic?: string;
  sessionId?: number;
  documentId?: number;
  // Only present for a topic lookup that resolved to a completed session -
  // lets research_task_status answer "what did you find out" directly,
  // without a second GET /research/:id round trip.
  findings?: { id: number; claim: string; confidence: string }[];
}

export async function getResearchStatus(config: Config, originSessionId: string): Promise<ResearchStatus> {
  const url = new URL(`${config.knowledgeEngineUrl}/research/status`);
  url.searchParams.set("sessionId", originSessionId);
  const res = await fetch(url.toString());
  return jsonOrThrow<ResearchStatus>(res, "Research status lookup");
}

// Real gap found via live testing: getResearchStatus above only ever finds
// a session tied to *this exact chat session* - background research
// queued ambiently and drained hours/overnight later is invisible to a
// "what have you found out about X" question asked from a different or
// later conversation. This checks by topic instead (any session, any
// status, most recent lexeme-overlap match on knowledge-engine's side).
export async function getResearchStatusByTopic(config: Config, topic: string): Promise<ResearchStatus> {
  const url = new URL(`${config.knowledgeEngineUrl}/research/status`);
  url.searchParams.set("topic", topic);
  const res = await fetch(url.toString());
  return jsonOrThrow<ResearchStatus>(res, "Research status lookup");
}

export interface ProjectProposeResult {
  id: number;
  title: string;
  status: string;
}

// Direct to knowledge-engine's POST /projects, not an n8n webhook - unlike
// skill_propose (which gates on a human manually flipping a status field
// in an n8n Data Table, the only place with no in-app approve action),
// projects have a real approve/reject surface on the /amy dashboard, so
// this follows research_task's direct-REST precedent instead.
export async function proposeProject(
  config: Config,
  input: { title: string; rationale: string; domain?: string },
): Promise<ProjectProposeResult> {
  const res = await fetch(`${config.knowledgeEngineUrl}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: input.title, rationale: input.rationale, domain: input.domain, origin: "amy_proposed" }),
  });
  return jsonOrThrow<ProjectProposeResult>(res, "Project proposal");
}
