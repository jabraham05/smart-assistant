import type { Config } from "../config.js";

// Direct to coding-orchestrator, not through the old n8n webhook shim
// skills-mcp's code_task tool still uses (CODING_TASK_WEBHOOK_URL) - that
// shim only exists for the immediate-chat-request path, which this doesn't
// touch. This is a new, separate caller straight into the same service,
// consistent with this project's ongoing direction of retiring n8n
// intermediary hops rather than adding a second caller onto an old one.

export interface CodingTask {
  id: number;
  task_description: string;
  target_repo_url: string | null;
  status: string; // running | proposed | needs_review_failed | resource_limit_reached
  latest_status: string | null;
  attempt_count: number;
  diff: string | null;
  test_output: string | null;
  reviewer_verdict: string | null;
  reviewer_reason: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

export async function startCodingTask(
  config: Config,
  input: { task: string; repoUrl?: string; originSessionId?: string },
): Promise<{ taskId: number }> {
  const res = await fetch(`${config.codingOrchestratorUrl}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: input.task, repoUrl: input.repoUrl, chatSessionId: input.originSessionId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`coding-orchestrator /task failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { taskId: number };
  return { taskId: data.taskId };
}

export async function getCodingTask(config: Config, taskId: number): Promise<CodingTask | undefined> {
  const res = await fetch(`${config.codingOrchestratorUrl}/tasks/${taskId}`);
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`coding-orchestrator /tasks/${taskId} failed: ${res.status}`);
  }
  return (await res.json()) as CodingTask;
}
