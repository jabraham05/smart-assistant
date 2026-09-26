// Server-side only, same "no client-side secrets/URLs" shape as
// coding-orchestrator-client.ts - graphiti-service is internal-only (no
// published port), so this only ever runs from a Next.js API route.
const GRAPHITI_SERVICE_URL = process.env.GRAPHITI_SERVICE_URL ?? "http://graphiti-service:3012";

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  summary?: string;
  kind: string;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  type: string;
  fact?: string;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export async function getKnowledgeGraph(groupId?: string, limit?: number): Promise<KnowledgeGraph> {
  const url = new URL(`${GRAPHITI_SERVICE_URL}/graph`);
  if (groupId) url.searchParams.set("groupId", groupId);
  if (limit) url.searchParams.set("limit", String(limit));
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`graphiti-service /graph failed with ${res.status}`);
  }
  return res.json();
}
