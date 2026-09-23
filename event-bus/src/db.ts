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
  task_context_id: number | null;
}

export interface InsertEventInput {
  source: string;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  originSessionId?: string;
  taskContextId?: number;
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

// Used by the new GET /events endpoint (see index.ts) - a plain read of
// the append-only audit trail, newest first. No filtering beyond an
// optional source, since this is a debugging/visibility surface (see
// docs/event-bus-and-goals.md), not a consumer-facing API with its own
// access-control needs.
export async function listRecentEvents(
  config: Config,
  limit: number,
  source?: string,
  type?: string,
  originSessionId?: string,
): Promise<EventRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (source) {
    params.push(source);
    conditions.push(`source = $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }
  if (originSessionId) {
    params.push(originSessionId);
    conditions.push(`origin_session_id = $${params.length}`);
  }
  params.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await getPool(config).query<EventRow>(
    `SELECT * FROM events ${where} ORDER BY occurred_at DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

// Backs GET /home-activity - the curated, cross-entity feed (see
// activity.ts's DIGEST_ALLOWLIST for which (source, type) pairs qualify).
// Matches on "source.type" strings rather than building a dynamic OR chain
// over pairs, since the allowlist is a flat, static list already shaped
// that way (same key format classify.ts uses).
export async function listDigestEvents(config: Config, allowedSourceTypes: string[], limit: number): Promise<EventRow[]> {
  const result = await getPool(config).query<EventRow>(
    `SELECT * FROM events WHERE (source || '.' || type) = ANY($1::text[]) ORDER BY occurred_at DESC LIMIT $2`,
    [allowedSourceTypes, limit],
  );
  return result.rows;
}

export async function insertEvent(config: Config, input: InsertEventInput): Promise<EventRow> {
  const result = await getPool(config).query<EventRow>(
    `INSERT INTO events (source, type, payload, occurred_at, origin_session_id, task_context_id)
     VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamptz, now()), $5, $6)
     RETURNING *`,
    [
      input.source,
      input.type,
      JSON.stringify(input.payload || {}),
      input.occurredAt || null,
      input.originSessionId || null,
      input.taskContextId ?? null,
    ],
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

// Events logged via knowledge-engine's logAwaitingDigest (deferred
// research-completion notify, see notify.ts) that the overnight digest
// scanner hasn't delivered yet - see event-bus's digest.ts.
export async function getPendingDigestEvents(config: Config): Promise<EventRow[]> {
  const result = await getPool(config).query<EventRow>(
    `SELECT * FROM events WHERE type = 'research_completed_awaiting_digest' AND status != 'notified' ORDER BY occurred_at ASC`,
  );
  return result.rows;
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

// Backs GET /home-activity's "goal progress" category. Reads
// goal_progress_log directly rather than mirroring it into `events` -
// it's already the append-only source of truth for real keyword matches
// (see the table's own comment in 04-create-events-db.sql).
export async function listRecentGoalProgress(config: Config, limit: number): Promise<
  { id: number; goal_id: number; goal_title: string; note: string | null; created_at: string }[]
> {
  const result = await getPool(config).query(
    `SELECT gpl.id, gpl.goal_id, g.title AS goal_title, gpl.note, gpl.created_at
     FROM goal_progress_log gpl
     JOIN goals g ON g.id = gpl.goal_id
     ORDER BY gpl.created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export interface TaskContextRow {
  id: number;
  objective: string;
  capability: string | null;
  domain: string | null;
  status: string;
  facts: unknown[];
  assumptions: unknown[];
  unknowns: unknown[];
  next_action: string | null;
  origin_session_id: string | null;
  source: string; // amy | user - see 19-add-task-context-source.sql
  created_at: string;
  updated_at: string;
}

export interface InsertTaskContextInput {
  objective: string;
  capability?: string;
  domain?: string;
  originSessionId?: string;
  source?: string;
}

// Real bug found via live testing: a duplicate "wax the car" task got
// created because create had no dedup at all - lexeme-overlap technique
// borrowed verbatim from knowledge-engine's research_queue dedup
// (findOverlappingPendingTopic), computing to_tsvector on the fly since
// task_contexts has no stored tsvector column (same tradeoff
// findResearchSessionByTopic already made for research_sessions - this
// isn't a hot path, no index needed).
export async function findOverlappingOpenTaskContext(
  config: Config,
  objective: string,
  minOverlap: number,
): Promise<TaskContextRow | undefined> {
  const result = await getPool(config).query<TaskContextRow>(
    `WITH query_lexemes AS (
       SELECT ARRAY(
         SELECT lex FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lex
         WHERE length(lex) >= 3
       ) AS lexemes
     ),
     scored AS (
       SELECT tc.*, COALESCE(array_length(ARRAY(
         SELECT unnest(query_lexemes.lexemes)
         INTERSECT
         SELECT unnest(tsvector_to_array(to_tsvector('english', tc.objective)))
       ), 1), 0) AS overlap_count
       FROM task_contexts tc
       CROSS JOIN query_lexemes
       WHERE tc.status IN ('active', 'waiting_for_user')
     )
     SELECT * FROM scored WHERE overlap_count >= $2
     ORDER BY overlap_count DESC, updated_at DESC LIMIT 1`,
    [objective, minOverlap],
  );
  return result.rows[0];
}

// Real bug found via live dogfooding: task contexts were injected into
// every chat turn's system prompt regardless of topic (see chat-orchestrator's
// getOpenTaskContexts), which let one standing personal reminder ("wax the
// car") bleed into and get conflated with completely unrelated
// conversations. This scopes that injection to only genuinely relevant
// task contexts, same lexeme-overlap technique as
// findOverlappingOpenTaskContext above (task_contexts has no keywords
// column like goals does, so free-text overlap against the objective is
// the matching signal) - just checked against arbitrary message text
// instead of a create/dedup candidate, and returning every match above
// the threshold rather than just the best one.
export async function matchOpenTaskContextsToText(
  config: Config,
  text: string,
  minOverlap = 1,
): Promise<TaskContextRow[]> {
  const result = await getPool(config).query<TaskContextRow>(
    `WITH query_lexemes AS (
       SELECT ARRAY(
         SELECT lex FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lex
         WHERE length(lex) >= 3
       ) AS lexemes
     ),
     scored AS (
       SELECT tc.*, COALESCE(array_length(ARRAY(
         SELECT unnest(query_lexemes.lexemes)
         INTERSECT
         SELECT unnest(tsvector_to_array(to_tsvector('english', tc.objective)))
       ), 1), 0) AS overlap_count
       FROM task_contexts tc
       CROSS JOIN query_lexemes
       WHERE tc.status IN ('active', 'waiting_for_user')
     )
     SELECT * FROM scored WHERE overlap_count >= $2
     ORDER BY overlap_count DESC, updated_at DESC`,
    [text, minOverlap],
  );
  return result.rows;
}

export async function insertTaskContext(config: Config, input: InsertTaskContextInput): Promise<TaskContextRow> {
  const result = await getPool(config).query<TaskContextRow>(
    `INSERT INTO task_contexts (objective, capability, domain, origin_session_id, source)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      input.objective,
      input.capability || null,
      input.domain || null,
      input.originSessionId || null,
      input.source || "amy",
    ],
  );
  return result.rows[0];
}

export async function getTaskContext(config: Config, taskContextId: number): Promise<TaskContextRow | undefined> {
  const result = await getPool(config).query<TaskContextRow>(`SELECT * FROM task_contexts WHERE id = $1`, [taskContextId]);
  return result.rows[0];
}

// status='open' is a virtual filter meaning "not yet resolved"
// (active|waiting_for_user), matching the two non-terminal states a task
// can be in - not a literal column value.
export async function listTaskContexts(config: Config, status?: string): Promise<TaskContextRow[]> {
  if (status === "open") {
    const result = await getPool(config).query<TaskContextRow>(
      `SELECT * FROM task_contexts WHERE status IN ('active', 'waiting_for_user') ORDER BY updated_at DESC`,
    );
    return result.rows;
  }
  if (status) {
    const result = await getPool(config).query<TaskContextRow>(
      `SELECT * FROM task_contexts WHERE status = $1 ORDER BY updated_at DESC`,
      [status],
    );
    return result.rows;
  }
  const result = await getPool(config).query<TaskContextRow>(`SELECT * FROM task_contexts ORDER BY updated_at DESC`);
  return result.rows;
}

export async function updateTaskContext(
  config: Config,
  taskContextId: number,
  fields: Partial<
    Pick<TaskContextRow, "objective" | "capability" | "domain" | "status" | "next_action"> & {
      facts: unknown[];
      assumptions: unknown[];
      unknowns: unknown[];
    }
  >,
): Promise<TaskContextRow | undefined> {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return getTaskContext(config, taskContextId);

  const jsonbFields = new Set(["facts", "assumptions", "unknowns"]);
  const setClauses = entries.map(([key], i) => (jsonbFields.has(key) ? `${key} = $${i + 2}::jsonb` : `${key} = $${i + 2}`));
  const values = entries.map(([key, value]) => (jsonbFields.has(key) ? JSON.stringify(value) : value));

  const result = await getPool(config).query<TaskContextRow>(
    `UPDATE task_contexts SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [taskContextId, ...values],
  );
  return result.rows[0];
}

export interface TaskContextStepRow {
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

// Bulk-create for action='plan' - the whole point is that the model
// proposes every step at once rather than one at a time, since it's
// planning the task's shape, not executing it yet.
export async function insertTaskContextSteps(
  config: Config,
  taskContextId: number,
  descriptions: string[],
): Promise<TaskContextStepRow[]> {
  const pool = getPool(config);
  const rows: TaskContextStepRow[] = [];
  for (let i = 0; i < descriptions.length; i++) {
    const result = await pool.query<TaskContextStepRow>(
      `INSERT INTO task_context_steps (task_context_id, step_index, description) VALUES ($1, $2, $3) RETURNING *`,
      [taskContextId, i, descriptions[i]],
    );
    rows.push(result.rows[0]);
  }
  await pool.query(`UPDATE task_contexts SET updated_at = now() WHERE id = $1`, [taskContextId]);
  return rows;
}

export async function listTaskContextSteps(config: Config, taskContextId: number): Promise<TaskContextStepRow[]> {
  const result = await getPool(config).query<TaskContextStepRow>(
    `SELECT * FROM task_context_steps WHERE task_context_id = $1 ORDER BY step_index ASC`,
    [taskContextId],
  );
  return result.rows;
}

export async function updateTaskContextStep(
  config: Config,
  stepId: number,
  fields: Partial<Pick<TaskContextStepRow, "status" | "failure_policy"> & { tool_result: unknown }>,
): Promise<TaskContextStepRow | undefined> {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    const result = await getPool(config).query<TaskContextStepRow>(`SELECT * FROM task_context_steps WHERE id = $1`, [stepId]);
    return result.rows[0];
  }

  const setClauses = entries.map(([key], i) => (key === "tool_result" ? `${key} = $${i + 2}::jsonb` : `${key} = $${i + 2}`));
  const values = entries.map(([key, value]) => (key === "tool_result" ? JSON.stringify(value) : value));

  const result = await getPool(config).query<TaskContextStepRow>(
    `UPDATE task_context_steps SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [stepId, ...values],
  );
  if (result.rows[0]) {
    await getPool(config).query(`UPDATE task_contexts SET updated_at = now() WHERE id = $1`, [result.rows[0].task_context_id]);
  }
  return result.rows[0];
}

export async function insertTaskContextLog(config: Config, taskContextId: number, note: string): Promise<void> {
  await getPool(config).query(`INSERT INTO task_context_log (task_context_id, note) VALUES ($1, $2)`, [taskContextId, note]);
  await getPool(config).query(`UPDATE task_contexts SET updated_at = now() WHERE id = $1`, [taskContextId]);
}

// Backs GET /task-contexts/:id/activity's `events` component - anything
// tagged with this task_context_id (currently task_context_created and
// task_context_updated, see index.ts), alongside the log/steps tables
// already scoped to the task.
export async function listEventsForTaskContext(config: Config, taskContextId: number): Promise<EventRow[]> {
  const result = await getPool(config).query<EventRow>(
    `SELECT * FROM events WHERE task_context_id = $1 ORDER BY occurred_at ASC`,
    [taskContextId],
  );
  return result.rows;
}

export async function getTaskContextLog(config: Config, taskContextId: number): Promise<
  { id: number; note: string; created_at: string }[]
> {
  const result = await getPool(config).query(
    `SELECT id, note, created_at FROM task_context_log WHERE task_context_id = $1 ORDER BY id ASC`,
    [taskContextId],
  );
  return result.rows;
}

// Backs the Chat workflow's cross-turn capability continuity (Get Last
// Active Capability node): the most recent classification the Chat
// workflow itself published for this session, skipping zero-group turns
// deliberately so a plain "thanks" doesn't erase real topic continuity for
// the next genuine follow-up.
export async function getLastCapability(config: Config, originSessionId: string): Promise<string[]> {
  const result = await getPool(config).query<{ groups: string[] }>(
    `SELECT payload->'relevantGroups' AS groups FROM events
     WHERE source = 'chat' AND type = 'message_received' AND origin_session_id = $1
       AND jsonb_array_length(payload->'relevantGroups') > 0
     ORDER BY occurred_at DESC LIMIT 1`,
    [originSessionId],
  );
  return result.rows[0]?.groups ?? [];
}

export async function getStaleGoals(config: Config, staleDays: number): Promise<GoalRow[]> {
  const result = await getPool(config).query<GoalRow>(
    `SELECT * FROM goals WHERE status = 'active' AND updated_at < now() - ($1 || ' days')::interval`,
    [staleDays],
  );
  return result.rows;
}

// Both scanner_state functions are scoped to a single named scanner (only
// 'skill_gap_scanner' exists today) rather than assuming one global
// cadence, so a second periodic scanner could get its own independent
// message-count cadence later without touching this one's state.

export async function getScannerLastRun(config: Config, key: string): Promise<Date> {
  const result = await getPool(config).query<{ last_run: string }>(
    `SELECT last_run FROM scanner_state WHERE key = $1`,
    [key],
  );
  // No row for an unrecognized key is a real bug (scanner_state is seeded
  // once via the init SQL, not created on demand), so this should never
  // actually throw in practice - fail loudly rather than silently picking
  // an arbitrary fallback that could under- or over-trigger the scanner.
  if (result.rows.length === 0) throw new Error(`No scanner_state row for key "${key}"`);
  return new Date(result.rows[0].last_run);
}

export async function countEventsSince(config: Config, source: string, type: string, since: Date): Promise<number> {
  const result = await getPool(config).query<{ count: string }>(
    `SELECT count(*) FROM events WHERE source = $1 AND type = $2 AND occurred_at > $3`,
    [source, type, since.toISOString()],
  );
  return Number(result.rows[0].count);
}

export async function touchScannerLastRun(config: Config, key: string): Promise<void> {
  await getPool(config).query(`UPDATE scanner_state SET last_run = now() WHERE key = $1`, [key]);
}

export interface CalendarWatcherStateRow {
  event_id: string;
  summary: string | null;
  start_time: string | null;
  first_seen_at: string;
  reminded_at: string | null;
}

export async function getCalendarWatcherState(
  config: Config,
  eventId: string,
): Promise<CalendarWatcherStateRow | undefined> {
  const result = await getPool(config).query<CalendarWatcherStateRow>(
    `SELECT * FROM calendar_watcher_state WHERE event_id = $1`,
    [eventId],
  );
  return result.rows[0];
}

export async function insertCalendarWatcherState(
  config: Config,
  input: { eventId: string; summary: string | null; startTime: string | null },
): Promise<void> {
  await getPool(config).query(
    `INSERT INTO calendar_watcher_state (event_id, summary, start_time) VALUES ($1, $2, $3)`,
    [input.eventId, input.summary, input.startTime],
  );
}

export async function markCalendarReminded(config: Config, eventId: string): Promise<void> {
  await getPool(config).query(`UPDATE calendar_watcher_state SET reminded_at = now() WHERE event_id = $1`, [
    eventId,
  ]);
}

// Keeps the table from growing forever - a day past start is well past any
// useful "already reminded" lookup for that event.
export async function pruneOldCalendarWatcherState(config: Config): Promise<void> {
  await getPool(config).query(`DELETE FROM calendar_watcher_state WHERE start_time < now() - interval '1 day'`);
}
