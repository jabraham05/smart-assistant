import type { Config } from "../config.js";

export interface ResearchTaskRequest {
  topic: string;
  // The chat session this task was triggered from, if any — captured at
  // the MCP transport layer (see server.ts's RequestContext), same as
  // code_task. Lets the pipeline post a real follow-up back into the same
  // conversation once it finishes. Absent for skill_gap_scanner-triggered
  // research, which has no chat session to report back into.
  chatSessionId?: string;
}

// POSTs to the research_pipeline n8n workflow's submit webhook. That
// webhook's trigger uses responseMode "onReceived" (see the workflow's own
// notes), same as coding_task_pipeline - it responds within roughly a tenth
// of a second, before the research agent/synthesis/embedding has run, so
// this genuinely is fire-and-forget despite awaiting the fetch.
export async function submitResearchTask(config: Config, payload: ResearchTaskRequest): Promise<void> {
  if (!config.researchTaskWebhookUrl) {
    throw new Error("RESEARCH_TASK_WEBHOOK_URL is not configured");
  }

  const res = await fetch(config.researchTaskWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Research task intake failed: ${res.status} ${body}`);
  }
}

export interface ResearchTaskStatus {
  found: boolean;
  status?: string;
  latestStatus?: string;
  title?: string;
  topic?: string;
}

// Real synchronous round trip (a Data lookup, not an LLM call, so this stays
// fast), same shape as getCodingTaskStatus.
export async function getResearchTaskStatus(config: Config, chatSessionId: string): Promise<ResearchTaskStatus> {
  if (!config.researchTaskStatusWebhookUrl) {
    throw new Error("RESEARCH_TASK_STATUS_WEBHOOK_URL is not configured");
  }

  const url = new URL(config.researchTaskStatusWebhookUrl);
  url.searchParams.set("sessionId", chatSessionId);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Research task status lookup failed: ${res.status} ${body}`);
  }

  return (await res.json()) as ResearchTaskStatus;
}

export interface ResearchSearchResultDocument {
  title: string;
  topic: string;
  sourceUrls: string[];
}

export interface ResearchSearchResult {
  content: string;
  heading?: string;
  similarity: number;
  document: ResearchSearchResultDocument;
}

// Synchronous RAG query - not scoped to any chat session (past research is
// recallable from any conversation), unlike code_task_status/research_task_status.
export async function searchResearch(
  config: Config,
  query: string,
  topK?: number,
): Promise<ResearchSearchResult[]> {
  if (!config.researchSearchWebhookUrl) {
    throw new Error("RESEARCH_SEARCH_WEBHOOK_URL is not configured");
  }

  const res = await fetch(config.researchSearchWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, topK }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Research search failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { results: ResearchSearchResult[] };
  return data.results;
}
