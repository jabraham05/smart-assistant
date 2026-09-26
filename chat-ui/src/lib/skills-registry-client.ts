import type { RegisteredTool } from "@/types/chat";

// Server-side only, same "no client-side secrets/URLs" shape as
// event-bus-client.ts - skills-mcp is internal-only (no published port), so
// this only ever runs from a Next.js API route, never the browser.
const SKILLS_MCP_URL = process.env.SKILLS_MCP_URL ?? "http://skills-mcp:3001";

export async function listRegisteredTools(): Promise<RegisteredTool[]> {
  const res = await fetch(`${SKILLS_MCP_URL}/tools`);
  if (!res.ok) {
    throw new Error(`skills-mcp /tools failed with ${res.status}`);
  }
  const data = (await res.json()) as { tools: RegisteredTool[] };
  return data.tools;
}

export interface SkillProposal {
  id: number;
  kind: "instruction" | "tool_idea";
  name: string;
  description: string;
  reason: string;
  instructions: string | null;
  tool_idea_details: string | null;
  status: "proposed" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
}

export async function getSkillProposals(status?: string): Promise<SkillProposal[]> {
  const url = new URL(`${SKILLS_MCP_URL}/skill-proposals`);
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`skills-mcp /skill-proposals failed with ${res.status}`);
  }
  const data = (await res.json()) as { proposals: SkillProposal[] };
  return data.proposals;
}

export async function reviewSkillProposal(id: number, action: "approve" | "reject"): Promise<SkillProposal> {
  const res = await fetch(`${SKILLS_MCP_URL}/skill-proposals/${id}/${action}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `skills-mcp /skill-proposals/${id}/${action} failed with ${res.status}`);
  }
  return res.json();
}
