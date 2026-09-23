// Server-side only, same "no client-side secrets/URLs" shape as
// knowledge-engine-client.ts - coding-orchestrator is internal-only (no
// published port), so this only ever runs from a Next.js API route.
const CODING_ORCHESTRATOR_URL = process.env.CODING_ORCHESTRATOR_URL ?? "http://coding-orchestrator:3003";

export interface CodingTask {
  id: number;
  task_description: string;
  target_repo_url: string | null;
  status: string; // running | proposed | needs_review_failed | resource_limit_reached
  latest_status: string | null;
  attempt_count: number;
  reviewer_reason: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

export async function getCodingTasks(status?: string, limit?: number): Promise<CodingTask[]> {
  const url = new URL(`${CODING_ORCHESTRATOR_URL}/tasks`);
  if (status) url.searchParams.set("status", status);
  if (limit) url.searchParams.set("limit", String(limit));
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`coding-orchestrator /tasks failed with ${res.status}`);
  }
  const data = (await res.json()) as { tasks: CodingTask[] };
  return data.tasks;
}
