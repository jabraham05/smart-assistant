import { Pool } from "pg";
import type { Config } from "./config.js";

let pool: Pool | undefined;

export function getPool(config: Config): Pool {
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

// Used by GET /health to prove the Phase 0 scaffolding actually talks to
// the real database and the new tables from 08-create-knowledge-tables.sql
// exist, not just that the process started.
export async function checkSchema(config: Config): Promise<{ connected: boolean; tables: string[] }> {
  const result = await getPool(config).query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [["documents", "sources", "chunks", "research_sessions", "findings", "citations", "knowledge_log"]],
  );
  return { connected: true, tables: result.rows.map((r) => r.table_name).sort() };
}
