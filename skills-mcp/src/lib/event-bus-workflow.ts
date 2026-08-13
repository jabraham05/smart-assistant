import type { Config } from "../config.js";

// Direct fetch to event-bus, not proxied through an n8n webhook - unlike
// code_task's n8n hop (a migration artifact kept only so its webhook URL
// didn't have to change when coding_task_pipeline's logic moved into
// coding-orchestrator), goal_manage has no such legacy. This mirrors the
// simpler direct-fetch pattern code_task_run_command/code_task_get_diff
// already use for always-on internal infra.

export interface GoalRecord {
  id: number;
  title: string;
  description: string | null;
  keywords: string[];
  status: string;
  origin_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateGoalInput {
  title: string;
  description?: string;
  keywords?: string[];
  originSessionId?: string;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string;
  status?: string;
  keywords?: string[];
}

async function jsonOrThrow<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

export async function createGoal(config: Config, input: CreateGoalInput): Promise<GoalRecord> {
  const res = await fetch(`${config.eventBusUrl}/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<GoalRecord>(res, "Goal creation");
}

export async function listGoals(config: Config, status?: string): Promise<GoalRecord[]> {
  const url = new URL(`${config.eventBusUrl}/goals`);
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url.toString());
  const data = await jsonOrThrow<{ goals: GoalRecord[] }>(res, "Goal list");
  return data.goals;
}

export async function updateGoal(config: Config, goalId: number, fields: UpdateGoalInput): Promise<GoalRecord> {
  const res = await fetch(`${config.eventBusUrl}/goals/${goalId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  return jsonOrThrow<GoalRecord>(res, "Goal update");
}

export interface GoalProgressEntry {
  id: number;
  event_id: number | null;
  note: string | null;
  created_at: string;
}

export async function getGoalProgress(
  config: Config,
  goalId: number,
): Promise<{ goal: GoalRecord; progress: GoalProgressEntry[] }> {
  const res = await fetch(`${config.eventBusUrl}/goals/${goalId}/progress`);
  return jsonOrThrow(res, "Goal progress lookup");
}
