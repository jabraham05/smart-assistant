import { Pool } from "pg";
import type { Config } from "./config.js";

export interface CodingTaskRow {
  id: number;
  task_description: string;
  target_repo_url: string | null;
  target_ref: string;
  test_command: string | null;
  fallback_repo_url: string | null;
  project_folder: string;
  origin_session_id: string | null;
  status: string;
  latest_status: string | null;
  attempt_count: number;
  container_id: string | null;
  diff: string | null;
  test_output: string | null;
  reviewer_verdict: string | null;
  reviewer_reason: string | null;
  pr_url: string | null;
}

export interface SubmitTaskInput {
  task: string;
  repoUrl?: string;
  ref?: string;
  testCommand?: string;
  chatSessionId?: string;
}

let pool: Pool | undefined;

function getPool(config: Config): Pool {
  if (!pool) {
    pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
    });
  }
  return pool;
}

function slugify(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export async function insertTask(config: Config, input: SubmitTaskInput): Promise<number> {
  const projectFolder = `${slugify(input.task)}-${Date.now()}`;
  const result = await getPool(config).query<{ id: number }>(
    `INSERT INTO coding_tasks
       (task_description, target_repo_url, target_ref, test_command, fallback_repo_url,
        project_folder, origin_session_id, status, latest_status, attempt_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', 'Setting up workspace', 1)
     RETURNING id`,
    [
      input.task,
      input.repoUrl || null,
      input.ref || "main",
      input.testCommand || null,
      config.codingTasksRepoUrl || null,
      projectFolder,
      input.chatSessionId || null,
    ],
  );
  return result.rows[0].id;
}

export async function getTask(config: Config, taskId: number): Promise<CodingTaskRow> {
  const result = await getPool(config).query<CodingTaskRow>(`SELECT * FROM coding_tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) {
    throw new Error(`coding task ${taskId} not found`);
  }
  return result.rows[0];
}

export async function getLatestTaskForSession(
  config: Config,
  sessionId: string,
): Promise<CodingTaskRow | undefined> {
  const result = await getPool(config).query<CodingTaskRow>(
    `SELECT * FROM coding_tasks WHERE origin_session_id = $1 ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );
  return result.rows[0];
}

export async function updateTask(
  config: Config,
  taskId: number,
  fields: Partial<
    Pick<
      CodingTaskRow,
      | "status"
      | "latest_status"
      | "attempt_count"
      | "container_id"
      | "diff"
      | "test_output"
      | "reviewer_verdict"
      | "reviewer_reason"
      | "pr_url"
      | "target_repo_url"
      | "project_folder"
    >
  >,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;

  const setClauses = entries.map(([key], i) => `${key} = $${i + 2}`);
  const values = entries.map(([, value]) => value);

  await getPool(config).query(
    `UPDATE coding_tasks SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1`,
    [taskId, ...values],
  );
}

export interface CodingSkillRow {
  id: number;
  name: string;
  role: string;
  template: string | null;
  content: string;
}

// role='coder'/'tester' pulls that role's own skills plus every 'both'
// skill; template=null (existing-repo tasks, or template='none') still
// gets every template-agnostic skill via the `template IS NULL` half of
// the OR - only a skill deliberately scoped to a specific template gets
// excluded when it doesn't match.
export async function getActiveCodingSkills(
  config: Config,
  role: "coder" | "tester",
  template: string | null,
): Promise<CodingSkillRow[]> {
  const result = await getPool(config).query<CodingSkillRow>(
    `SELECT id, name, role, template, content FROM coding_skills
     WHERE status = 'active' AND role IN ($1, 'both') AND (template IS NULL OR template = $2)
     ORDER BY id`,
    [role, template],
  );
  return result.rows;
}

export async function logPhase(
  config: Config,
  taskId: number,
  attemptNumber: number | null,
  phase: string,
  status: "success" | "error",
  content: string,
  errorMessage?: string,
): Promise<void> {
  await getPool(config).query(
    `INSERT INTO coding_task_log (task_id, attempt_number, phase, status, error_message, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [taskId, attemptNumber, phase, status, errorMessage || null, content],
  );
}
