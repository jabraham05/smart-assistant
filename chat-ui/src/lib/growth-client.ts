// Server-side only, same "no client-side secrets/URLs" shape as
// skills-registry-client.ts/event-bus-client.ts - agent-service is internal-
// only (no published port on the host), so this only ever runs from a
// Next.js API route, never the browser. Growth's own data access lives in
// agent-service (growth_routes.py), not a dedicated microservice - this
// mirrors that directly rather than adding another hop.
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? "http://agent-service:3010";

export interface GrowthOpportunity {
  id: number;
  title: string;
  description: string;
  category: string | null;
  frequency: number;
  usefulness: number | null;
  confidence: number | null;
  reuse_potential: number | null;
  improvement_value: number | null;
  effort: number | null;
  interruption_cost: number | null;
  score: number | null;
  status: "observed" | "scored" | "proposed" | "rejected" | "dormant";
  first_observed_at: string;
  last_observed_at: string;
  created_at: string;
  updated_at: string;
}

export interface GrowthProposal {
  id: number;
  opportunity_id: number;
  category: "knowledge" | "skill" | "behavior" | "tool";
  proposed_action: string;
  rationale: string;
  approval_tier: "tier1" | "tier2" | "tier3";
  status: "proposed" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  opportunity_title?: string;
  opportunity_description?: string;
  opportunity_confidence?: number | null;
  opportunity_score?: number | null;
  opportunity_frequency?: number | null;
  current_text?: string | null;
  proposed_text?: string | null;
  preview_evaluation?: Record<string, unknown> | null;
}

export interface LearningPlanStep {
  description: string;
  status: "pending" | "completed" | "failed";
}

export interface LearningPlan {
  id: number;
  proposal_id: number;
  goal: string;
  steps: LearningPlanStep[];
  status: "active" | "complete" | "abandoned";
  created_at: string;
  updated_at: string;
  proposal_category?: string;
  proposed_action?: string;
  opportunity_title?: string;
}

export interface GrowthExperiment {
  id: number;
  learning_plan_id: number | null;
  proposal_id: number | null;
  description: string;
  baseline_definition: Record<string, unknown>;
  candidate_definition: Record<string, unknown>;
  status: "pending" | "running" | "complete" | "failed";
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  evaluation_id: number | null;
  metric: string | null;
  baseline_score: number | null;
  candidate_score: number | null;
  improved: boolean | null;
  baseline_results: Record<string, unknown> | null;
  candidate_results: Record<string, unknown> | null;
  evaluation_notes: string | null;
  evaluated_at: string | null;
  proposal_category?: string;
  opportunity_title?: string;
}

export interface GrowthHistoryEntry {
  id: number;
  opportunity_id: number | null;
  proposal_id: number | null;
  event_type: string;
  detail: Record<string, unknown>;
  entity_id: string | null;
  created_at: string;
  opportunity_title?: string;
  proposal_category?: string;
}

export interface ProposalPreview {
  ok: boolean;
  error?: string;
  category: "knowledge" | "skill" | "behavior" | "tool";
  currentText: string;
  proposedText: string;
  diff: string[];
  evaluation: Record<string, unknown> | null;
  observations: { summary: string; source: string }[];
  opportunity: { confidence: number | null; score: number | null; frequency: number | null };
}

export interface TeachingSession {
  id: number;
  session_id: string | null;
  mode: "demonstration" | "guided_practice" | "explain_and_build";
  status: "capturing" | "classified" | "routed" | "consolidated" | "abandoned";
  captured_content: string;
  category: "knowledge" | "skill" | "behavior" | "tool" | null;
  classification_reasoning: string | null;
  extracted_procedure: string | null;
  extracted_rules: string | null;
  extracted_examples: string | null;
  open_questions: string | null;
  opportunity_id: number | null;
  proposal_id: number | null;
  created_at: string;
}

export interface PersonaProposal {
  pending: boolean;
  name?: string;
  system_prompt?: string;
  proposed_system_prompt?: string;
  proposed_reason?: string;
  proposed_at?: string;
  diff?: string[];
}

async function getJson<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, AGENT_SERVICE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`agent-service ${path} failed with ${res.status}`);
  return res.json();
}

async function postJson<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(new URL(path, AGENT_SERVICE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    // Approving a proposal can trigger a golden-transcript regression
    // check (several real LLM calls) - matches growth-client.ts's own
    // timeout on the skills-mcp side for the same route.
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `agent-service ${path} failed with ${res.status}`);
  return data as T;
}

export async function listGrowthOpportunities(status?: string): Promise<GrowthOpportunity[]> {
  const data = await getJson<{ opportunities: GrowthOpportunity[] }>("/growth/opportunities", { status });
  return data.opportunities;
}

export async function dismissOpportunity(id: number) {
  return postJson<{ ok: boolean }>(`/growth/opportunities/${id}/dismiss`);
}

export async function deferOpportunity(id: number) {
  return postJson<{ ok: boolean }>(`/growth/opportunities/${id}/defer`);
}

export async function promoteOpportunity(id: number) {
  return postJson<{ ok: boolean; proposalId?: number; error?: string }>(`/growth/opportunities/${id}/promote`);
}

export async function listGrowthProposals(status?: string): Promise<GrowthProposal[]> {
  const data = await getJson<{ proposals: GrowthProposal[] }>("/growth/proposals", { status });
  return data.proposals;
}

export async function getGrowthProposal(id: number): Promise<GrowthProposal> {
  return getJson<GrowthProposal>(`/growth/proposals/${id}`);
}

export async function previewGrowthProposal(id: number): Promise<ProposalPreview> {
  return postJson<ProposalPreview>(`/growth/proposals/${id}/preview`);
}

export async function approveGrowthProposal(id: number, notes?: string) {
  return postJson<{ ok: boolean; consolidation?: Record<string, unknown> }>(`/growth/proposals/${id}/approve`, { notes });
}

export async function rejectGrowthProposal(id: number, notes?: string) {
  return postJson<{ ok: boolean }>(`/growth/proposals/${id}/reject`, { notes });
}

export async function listLearningPlans(status?: string): Promise<LearningPlan[]> {
  const data = await getJson<{ learningPlans: LearningPlan[] }>("/growth/learning-plans", { status });
  return data.learningPlans;
}

export async function listGrowthExperiments(): Promise<GrowthExperiment[]> {
  const data = await getJson<{ experiments: GrowthExperiment[] }>("/growth/experiments");
  return data.experiments;
}

export async function listGrowthHistory(limit?: number): Promise<GrowthHistoryEntry[]> {
  const data = await getJson<{ history: GrowthHistoryEntry[] }>("/growth/history", { limit });
  return data.history;
}

export async function listTeachingSessions(status?: string): Promise<TeachingSession[]> {
  const data = await getJson<{ teachingSessions: TeachingSession[] }>("/growth/teaching-sessions", { status });
  return data.teachingSessions;
}

export async function getPersonaProposal(): Promise<PersonaProposal> {
  return getJson<PersonaProposal>("/growth/persona-proposal");
}

export async function promotePersonaProposal(): Promise<{ ok: boolean; reason?: string }> {
  return postJson<{ ok: boolean; reason?: string }>("/growth/persona-proposal/promote");
}

export async function dismissPersonaProposal(reason?: string): Promise<{ ok: boolean; reason?: string }> {
  return postJson<{ ok: boolean; reason?: string }>("/growth/persona-proposal/dismiss", { reason });
}
