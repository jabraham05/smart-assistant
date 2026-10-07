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

// Phase 1 of the "Amy's world" rework (see knowledge-engine's 23-create-
// entities-table.sql) - a registry of durable things, independent of which
// table/service produced them. Currently only `type: "project"` rows
// exist (written by consolidate.ts on project completion); the dashboard's
// Growth tab is written to show whatever types show up here, not just this
// one.
export interface Entity {
  id: string;
  type: string;
  name: string;
  description: string | null;
  status: string | null;
  source_table: string | null;
  source_id: string | null;
  source_path: string | null;
  graphiti_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface EntityDetail extends Entity {
  // The backing file's raw markdown, read fresh on every request (see
  // engine/entities.ts's readEntityFile) - null if the entity has no
  // source_path or the file is missing on disk.
  content: string | null;
}

export async function getEntities(type?: string): Promise<Entity[]> {
  const url = new URL(`${KNOWLEDGE_ENGINE_URL}/entities`);
  if (type) url.searchParams.set("type", type);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`knowledge-engine /entities failed with ${res.status}`);
  }
  const data = (await res.json()) as { entities: Entity[] };
  return data.entities;
}

export async function getEntityDetail(id: string): Promise<EntityDetail | null> {
  const res = await fetch(`${KNOWLEDGE_ENGINE_URL}/entities/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`knowledge-engine /entities/${id} failed with ${res.status}`);
  }
  return (await res.json()) as EntityDetail;
}

// Raw directory browser over KNOWLEDGE_STORE_PATH, independent of the
// `entities` registry - powers Amy Lab's "Files" tab.
export interface KnowledgeStoreFile {
  relativePath: string;
  size: number;
  mtime: string;
}

export async function getKnowledgeStoreFiles(): Promise<KnowledgeStoreFile[]> {
  const res = await fetch(`${KNOWLEDGE_ENGINE_URL}/knowledge-store/files`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`knowledge-engine /knowledge-store/files failed with ${res.status}`);
  }
  const data = (await res.json()) as { files: KnowledgeStoreFile[] };
  return data.files;
}

export async function getKnowledgeStoreFileContent(relativePath: string): Promise<string> {
  const url = new URL(`${KNOWLEDGE_ENGINE_URL}/knowledge-store/files/content`);
  url.searchParams.set("path", relativePath);
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error ?? `knowledge-engine /knowledge-store/files/content failed with ${res.status}`);
  }
  return (data as { content: string }).content;
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
