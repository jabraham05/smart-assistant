import { Pool } from "pg";
import "./pg-types.js"; // BIGINT ids/counts as numbers, not strings
import type { Config } from "./config.js";

// event-bus opens read-only pools into two databases it doesn't otherwise
// own (coding_tasks, research) purely to answer "is a task currently
// running" - same precedent as notify.ts's getN8nPool: same Postgres
// host/user/password, just a different database name, not a new secret.

let codingTasksPool: Pool | undefined;

function getCodingTasksPool(config: Config): Pool {
  if (!codingTasksPool) {
    codingTasksPool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.codingTasksDbName,
      user: config.postgres.user,
      password: config.postgres.password,
    });
  }
  return codingTasksPool;
}

let researchPool: Pool | undefined;

function getResearchPool(config: Config): Pool {
  if (!researchPool) {
    researchPool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.researchDbName,
      user: config.postgres.user,
      password: config.postgres.password,
    });
  }
  return researchPool;
}

export interface WorkLevel {
  codingActive: number;
  researchActive: number;
  level: "low" | "high";
}

// "Actively in progress" per each database's own status model: coding_tasks
// has no separate queued state (running from the moment it's inserted, see
// postgres/init/03-create-coding-tasks-db.sql), research_sessions likewise
// (running | complete | failed, see postgres/init/08-create-knowledge-tables.sql).
// research_sessions replaces the old research_documents table, which the
// knowledge-engine cutover left dead - nothing has written to it since, so
// this query was silently reporting 0 unconditionally until this fix.
export async function getWorkLevel(config: Config): Promise<WorkLevel> {
  const [codingResult, researchResult] = await Promise.all([
    getCodingTasksPool(config).query<{ count: number }>(`SELECT count(*) FROM coding_tasks WHERE status = 'running'`),
    getResearchPool(config).query<{ count: number }>(
      `SELECT count(*) FROM research_sessions WHERE status = 'running'`,
    ),
  ]);

  const codingActive = codingResult.rows[0].count;
  const researchActive = researchResult.rows[0].count;

  return {
    codingActive,
    researchActive,
    level: codingActive + researchActive > 0 ? "high" : "low",
  };
}
