import type { Config } from "../config.js";

// Direct to coding-orchestrator, not through the old CODING_TASK_WEBHOOK_URL
// n8n shim code_task/code_task_status still use for submission - this is a
// new, read-only caller into the same service, consistent with this
// project's ongoing direction of retiring n8n intermediary hops rather
// than adding a second one onto an old shim (same call knowledge-engine's
// own coding-orchestrator client already makes).

export interface CodingTaskListItem {
  id: number;
  task_description: string;
  status: string; // running | proposed | needs_review_failed | resource_limit_reached
  pr_url: string | null;
  updated_at: string;
}

export async function listCodingTasks(config: Config, limit = 10): Promise<CodingTaskListItem[]> {
  const url = new URL(`${config.codingOrchestratorUrl}/tasks`);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`coding-orchestrator /tasks failed: ${res.status}`);
  }
  const data = (await res.json()) as { tasks: CodingTaskListItem[] };
  return data.tasks;
}
