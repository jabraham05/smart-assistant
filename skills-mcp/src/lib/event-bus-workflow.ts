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

export interface TaskContextRecord {
  id: number;
  objective: string;
  capability: string | null;
  domain: string | null;
  status: string;
  origin_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskContextInput {
  objective: string;
  capability?: string;
  domain?: string;
  originSessionId?: string;
}

export interface UpdateTaskContextInput {
  objective?: string;
  capability?: string;
  domain?: string;
  status?: string;
}

export async function createTaskContext(config: Config, input: CreateTaskContextInput): Promise<TaskContextRecord> {
  const res = await fetch(`${config.eventBusUrl}/task-contexts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<TaskContextRecord>(res, "Task context creation");
}

export async function listTaskContexts(config: Config, status?: string): Promise<TaskContextRecord[]> {
  const url = new URL(`${config.eventBusUrl}/task-contexts`);
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url.toString());
  const data = await jsonOrThrow<{ taskContexts: TaskContextRecord[] }>(res, "Task context list");
  return data.taskContexts;
}

export async function updateTaskContext(
  config: Config,
  taskContextId: number,
  fields: UpdateTaskContextInput,
): Promise<TaskContextRecord> {
  const res = await fetch(`${config.eventBusUrl}/task-contexts/${taskContextId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  return jsonOrThrow<TaskContextRecord>(res, "Task context update");
}

export async function logTaskContext(config: Config, taskContextId: number, note: string): Promise<void> {
  const res = await fetch(`${config.eventBusUrl}/task-contexts/${taskContextId}/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  await jsonOrThrow(res, "Task context log");
}

export interface TaskContextStepRecord {
  id: number;
  task_context_id: number;
  step_index: number;
  description: string;
  status: string;
  failure_policy: string | null;
  tool_result: unknown;
  created_at: string;
  updated_at: string;
}

export async function createTaskContextSteps(
  config: Config,
  taskContextId: number,
  descriptions: string[],
): Promise<TaskContextStepRecord[]> {
  const res = await fetch(`${config.eventBusUrl}/task-contexts/${taskContextId}/steps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ descriptions }),
  });
  const data = await jsonOrThrow<{ steps: TaskContextStepRecord[] }>(res, "Task context step creation");
  return data.steps;
}

export async function listTaskContextSteps(config: Config, taskContextId: number): Promise<TaskContextStepRecord[]> {
  const res = await fetch(`${config.eventBusUrl}/task-contexts/${taskContextId}/steps`);
  const data = await jsonOrThrow<{ steps: TaskContextStepRecord[] }>(res, "Task context step list");
  return data.steps;
}

export async function updateTaskContextStep(
  config: Config,
  taskContextId: number,
  stepId: number,
  fields: { status?: string; failurePolicy?: string; toolResult?: unknown },
): Promise<TaskContextStepRecord> {
  const res = await fetch(`${config.eventBusUrl}/task-contexts/${taskContextId}/steps/${stepId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  return jsonOrThrow<TaskContextStepRecord>(res, "Task context step update");
}
