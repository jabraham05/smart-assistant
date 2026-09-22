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
}

export async function getResearchDetail(id: string): Promise<ResearchSessionDetail | null> {
  const res = await fetch(`${KNOWLEDGE_ENGINE_URL}/research/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`knowledge-engine /research/${id} failed with ${res.status}`);
  }
  return (await res.json()) as ResearchSessionDetail;
}
