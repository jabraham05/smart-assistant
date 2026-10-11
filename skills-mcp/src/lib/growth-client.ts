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

export interface PersonaProposal {
  pending: boolean;
  name?: string;
  system_prompt?: string;
  proposed_system_prompt?: string;
  proposed_reason?: string;
  proposed_at?: string;
}

// Follow-up fix: personas.proposed_system_prompt was only ever readable/
// applicable via raw SQL - including a real proposal from 2026-08-21 that
// predates the Growth engine. This is what makes it reachable
// conversationally instead.
export async function getPersonaProposal(config: Config, name = "Amy"): Promise<PersonaProposal> {
  const url = new URL("/growth/persona-proposal", config.agentServiceUrl);
  url.searchParams.set("name", name);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  return res.json();
}

export async function promotePersonaProposal(config: Config, name = "Amy"): Promise<Record<string, unknown>> {
  const res = await fetch(new URL("/growth/persona-proposal/promote", config.agentServiceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  return res.json();
}

export async function dismissPersonaProposal(config: Config, name = "Amy", reason?: string): Promise<Record<string, unknown>> {
  const res = await fetch(new URL("/growth/persona-proposal/dismiss", config.agentServiceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, reason }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  return res.json();
}

// Phase 10 (Teaching layer) - growth_teaching.py / the /growth/teaching-
// sessions routes in growth_routes.py. This is the actual capture hook:
// Amy calls this herself when she recognizes the user is teaching her
// something, the same "model-invoked mid-conversation" idiom skill_propose
// already uses, rather than a new field on the per-turn classifier.
export interface TeachingSession {
  id: number;
  session_id: string | null;
  mode: "demonstration" | "guided_practice" | "explain_and_build";
  status: "capturing" | "classified" | "routed" | "consolidated" | "abandoned";
  captured_content: string;
  category: string | null;
  classification_reasoning: string | null;
  extracted_procedure: string | null;
  extracted_rules: string | null;
  extracted_examples: string | null;
  open_questions: string | null;
  opportunity_id: number | null;
  proposal_id: number | null;
  created_at: string;
}

export async function startTeachingSession(
  config: Config,
  mode: TeachingSession["mode"],
  content: string,
  sessionId?: string,
  finalizeImmediately?: boolean,
): Promise<Record<string, unknown>> {
  const res = await fetch(new URL("/growth/teaching-sessions", config.agentServiceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, content, sessionId, finalizeImmediately }),
    // finalizeImmediately chains a judge classification call AND, for
    // skill/behavior, a plausibility/regression check - two sequential
    // judge calls in one request. Live-tested and found 60s insufficient
    // under load (a real ReadTimeout, not just the model declining to call
    // this tool) - same generous ceiling approve already uses for its own
    // regression check.
    signal: AbortSignal.timeout(finalizeImmediately ? 120_000 : 10_000),
  });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  return res.json();
}

export async function captureTeachingContent(
  config: Config,
  teachingSessionId: number,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(new URL(`/growth/teaching-sessions/${teachingSessionId}/capture`, config.agentServiceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  return res.json();
}

export async function finalizeTeachingSession(
  config: Config,
  teachingSessionId: number,
): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(`/growth/teaching-sessions/${teachingSessionId}/finalize`, config.agentServiceUrl), {
    method: "POST",
    // Runs a judge classification call, and - for skill/behavior categories
    // that clear the proposal threshold - a plausibility/regression check
    // too (same cost shape approve already has).
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  return res.json();
}

export async function getTeachingSession(config: Config, teachingSessionId: number): Promise<TeachingSession> {
  const res = await fetch(new URL(`/growth/teaching-sessions/${teachingSessionId}`, config.agentServiceUrl), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`agent-service returned ${res.status}`);
  return res.json();
}
