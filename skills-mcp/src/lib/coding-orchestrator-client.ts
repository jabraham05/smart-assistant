import type { Config } from "../config.js";

// Direct to coding-orchestrator - a read-only caller into the same service
// lib/coding-workflow.ts's submitCodingTask/getCodingTaskStatus also call
// directly (the old CODING_TASK_WEBHOOK_URL n8n shim they used to submit
// through is retired - see coding-workflow.ts's own comment), consistent
// with this project's direction of retiring n8n intermediary hops (same
// call knowledge-engine's own coding-orchestrator client already makes).

export interface CodingTaskListItem {
  id: number;
  task_description: string;
  status: string; // running | proposed | needs_review_failed | resource_limit_reached
  // approve | approve_partial | retry | give_up | null - "approve_partial"
  // means real, working code for a smaller scope than asked, honestly
  // disclosed (see coding-orchestrator/src/pipeline.ts's Reviewer prompt).
  reviewer_verdict: string | null;
  reviewer_reason: string | null;
  pr_url: string | null;
  updated_at: string;
}

export async function listCodingTasks(config: Config, limit = 10, status?: string): Promise<CodingTaskListItem[]> {
  const url = new URL(`${config.codingOrchestratorUrl}/tasks`);
  url.searchParams.set("limit", String(limit));
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`coding-orchestrator /tasks failed: ${res.status}`);
  }
  const data = (await res.json()) as { tasks: CodingTaskListItem[] };
  return data.tasks;
}
