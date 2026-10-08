import type { Config } from "../config.js";

// Thin proxy to agent-service's /growth/* routes (growth_routes.py) - the
// Growth engine's own data access lives in agent-service, not here, same
// "MCP tool calls the owning service's HTTP API" pattern task-context-
// manage.ts already uses for event-bus.

export interface GrowthOpportunity {
  id: number;
  title: string;
  description: string;
  category: string | null;
  frequency: number;
  score: number | null;
  status: string;
  updated_at: string;
}

export interface GrowthProposal {
  id: number;
  opportunity_id: number;
  category: string;
  proposed_action: string;
  rationale: string;
  approval_tier: string;
  status: string;
  created_at: string;
  reviewer_notes?: string | null;
  opportunity_title?: string;
  opportunity_description?: string;
}

export async function listOpportunities(config: Config, status?: string): Promise<GrowthOpportunity[]> {
  const url = new URL("/growth/opportunities", config.agentServiceUrl);
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  const data = (await res.json()) as { opportunities: GrowthOpportunity[] };
  return data.opportunities;
}

export async function listProposals(config: Config, status?: string): Promise<GrowthProposal[]> {
  const url = new URL("/growth/proposals", config.agentServiceUrl);
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  const data = (await res.json()) as { proposals: GrowthProposal[] };
  return data.proposals;
}

export async function approveProposal(config: Config, proposalId: number, notes?: string): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(`/growth/proposals/${proposalId}/approve`, config.agentServiceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
    signal: AbortSignal.timeout(60_000), // can trigger a golden-transcript regression check
  });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  return res.json();
}

export async function rejectProposal(config: Config, proposalId: number, notes?: string): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(`/growth/proposals/${proposalId}/reject`, config.agentServiceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  return res.json();
}
