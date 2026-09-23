// Server-side only, same "no client-side secrets/URLs" shape as
// event-bus-client.ts/skills-registry-client.ts - knowledge-engine is
// internal-only (no published port), so this only ever runs server-side
// (a Next.js Server Component page, in this case, not an API route - see
// src/app/research/[id]/page.tsx).
const KNOWLEDGE_ENGINE_URL = process.env.KNOWLEDGE_ENGINE_URL ?? "http://knowledge-engine:3005";

export interface ResearchCitation {
  source_url: string | null;
  source_title: string | null;
  excerpt: string;
  supports: boolean;
}

export interface ResearchFinding {
  id: number;
  claim: string;
  confidence: string;
  citations: ResearchCitation[];
}

export interface ResearchSessionDetail {
  session: {
    id: number;
    topic: string;
    domain: string | null;
    status: string;
    trigger_source: string;
    created_at: string;
    updated_at: string;
  };
  findings: ResearchFinding[];
  // Set once a linked project (see /amy) consolidates this session's
  // findings into a narrative write-up - see db.ts's getResearchSessionDetail.
  documentMarkdown: string | null;
}

export async function getResearchDetail(id: string): Promise<ResearchSessionDetail | null> {
  const res = await fetch(`${KNOWLEDGE_ENGINE_URL}/research/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`knowledge-engine /research/${id} failed with ${res.status}`);
  }
  return (await res.json()) as ResearchSessionDetail;
}

export interface Project {
  id: number;
  title: string;
  rationale: string;
  domain: string | null;
  status: string;
  origin: string;
  activity_type: string; // research | coding
  research_queue_id: number | null;
  research_session_id: number | null;
  coding_task_id: number | null;
  target_repo_url: string | null;
  document_id: number | null;
  research_queue_status: string | null;
  coding_task_status: string | null;
  coding_task_pr_url: string | null;
  created_at: string;
  approved_at: string | null;
  updated_at: string;
}

export async function getProjects(status?: string): Promise<Project[]> {
  const url = new URL(`${KNOWLEDGE_ENGINE_URL}/projects`);
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`knowledge-engine /projects failed with ${res.status}`);
  }
  const data = (await res.json()) as { projects: Project[] };
  return data.projects;
}

async function postProjectAction(id: number, action: "approve" | "reject" | "complete"): Promise<Project> {
  const res = await fetch(`${KNOWLEDGE_ENGINE_URL}/projects/${id}/${action}`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error ?? `knowledge-engine /projects/${id}/${action} failed with ${res.status}`);
  }
  return body as Project;
}

export const approveProject = (id: number) => postProjectAction(id, "approve");
export const rejectProject = (id: number) => postProjectAction(id, "reject");
export const completeProject = (id: number) => postProjectAction(id, "complete");

// Artifact Registry's search box - ported from the old ops-dashboard's
// knowledge-engine-client.ts (ops-dashboard is retired, this is its only
// piece worth keeping).
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
}

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
