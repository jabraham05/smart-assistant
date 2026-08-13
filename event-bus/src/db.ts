import { Pool } from "pg";
import type { Config } from "./config.js";

export interface EventRow {
  id: number;
  source: string;
  type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  origin_session_id: string | null;
  priority: string;
  should_notify: boolean;
  status: string;
  notified_at: string | null;
  created_at: string;
}

export interface InsertEventInput {
  source: string;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  originSessionId?: string;
}

export interface GoalRow {
  id: number;
  title: string;
  description: string | null;
  keywords: string[];
  status: string;
  origin_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertGoalInput {
  title: string;
  description?: string;
  keywords: string[];
  originSessionId?: string;
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

export async function insertEvent(config: Config, input: InsertEventInput): Promise<EventRow> {
  const result = await getPool(config).query<EventRow>(
    `INSERT INTO events (source, type, payload, occurred_at, origin_session_id)
     VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamptz, now()), $5)
     RETURNING *`,
    [input.source, input.type, JSON.stringify(input.payload || {}), input.occurredAt || null, input.originSessionId || null],
  );
  return result.rows[0];
}

export async function updateEventClassification(
  config: Config,
  eventId: number,
  fields: { priority: string; should_notify: boolean },
): Promise<void> {
  await getPool(config).query(`UPDATE events SET priority = $2, should_notify = $3 WHERE id = $1`, [
    eventId,
    fields.priority,
    fields.should_notify,
  ]);
}

export async function markEventStatus(config: Config, eventId: number, status: string, notified = false): Promise<void> {
  await getPool(config).query(
    `UPDATE events SET status = $2, notified_at = CASE WHEN $3 THEN now() ELSE notified_at END WHERE id = $1`,
    [eventId, status, notified],
  );
}

export async function insertGoal(config: Config, input: InsertGoalInput): Promise<GoalRow> {
  const result = await getPool(config).query<GoalRow>(
    `INSERT INTO goals (title, description, keywords, origin_session_id)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING *`,
    [input.title, input.description || null, JSON.stringify(input.keywords), input.originSessionId || null],
  );
  return result.rows[0];
}

export async function getGoal(config: Config, goalId: number): Promise<GoalRow | undefined> {
  const result = await getPool(config).query<GoalRow>(`SELECT * FROM goals WHERE id = $1`, [goalId]);
  return result.rows[0];
}

export async function listGoals(config: Config, status?: string): Promise<GoalRow[]> {
  if (status) {
    const result = await getPool(config).query<GoalRow>(
      `SELECT * FROM goals WHERE status = $1 ORDER BY updated_at DESC`,
      [status],
    );
    return result.rows;
  }
  const result = await getPool(config).query<GoalRow>(`SELECT * FROM goals ORDER BY updated_at DESC`);
  return result.rows;
}

export async function listActiveGoals(config: Config): Promise<GoalRow[]> {
  return listGoals(config, "active");
}

export async function updateGoal(
  config: Config,
  goalId: number,
  fields: Partial<Pick<GoalRow, "title" | "description" | "status">> & { keywords?: string[] },
): Promise<GoalRow | undefined> {
  const entries: [string, unknown][] = [];
  if (fields.title !== undefined) entries.push(["title", fields.title]);
  if (fields.description !== undefined) entries.push(["description", fields.description]);
  if (fields.status !== undefined) entries.push(["status", fields.status]);
  if (fields.keywords !== undefined) entries.push(["keywords", JSON.stringify(fields.keywords)]);
  if (entries.length === 0) return getGoal(config, goalId);

  const setClauses = entries.map(([key], i) => (key === "keywords" ? `keywords = $${i + 2}::jsonb` : `${key} = $${i + 2}`));
  const values = entries.map(([, value]) => value);

  const result = await getPool(config).query<GoalRow>(
    `UPDATE goals SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [goalId, ...values],
  );
  return result.rows[0];
}

export async function touchGoal(config: Config, goalId: number): Promise<void> {
  await getPool(config).query(`UPDATE goals SET updated_at = now() WHERE id = $1`, [goalId]);
}

export async function insertProgressLog(
  config: Config,
  goalId: number,
  eventId: number | null,
  note: string,
): Promise<void> {
  await getPool(config).query(
    `INSERT INTO goal_progress_log (goal_id, event_id, note) VALUES ($1, $2, $3)`,
    [goalId, eventId, note],
  );
}

export async function getProgressLog(config: Config, goalId: number, limit = 20): Promise<
  { id: number; event_id: number | null; note: string | null; created_at: string }[]
> {
  const result = await getPool(config).query(
    `SELECT id, event_id, note, created_at FROM goal_progress_log
     WHERE goal_id = $1 ORDER BY id DESC LIMIT $2`,
    [goalId, limit],
  );
  return result.rows;
}

export async function getStaleGoals(config: Config, staleDays: number): Promise<GoalRow[]> {
  const result = await getPool(config).query<GoalRow>(
    `SELECT * FROM goals WHERE status = 'active' AND updated_at < now() - ($1 || ' days')::interval`,
    [staleDays],
  );
  return result.rows;
}
