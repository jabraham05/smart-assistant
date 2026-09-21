import { Pool } from "pg";
import type { Config } from "./config.js";

// Reads only, against a schema-configurable view of the persona/skills
// data - 'public' (the real views onto n8n's live Data Tables, see
// postgres/init/10-add-chat-test-schema.sql) for production, 'chat_test'
// for the side-by-side test instance. Nothing here ever writes: approving
// a skill or editing a persona still happens exactly where it does today,
// in n8n's Data Table UI (or directly in chat_test's plain tables while
// trying something out).

let pool: Pool | undefined;

function getPool(config: Config): Pool {
  if (!pool) {
    pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.n8nDatabase,
      user: config.postgres.user,
      password: config.postgres.password,
    });
  }
  return pool;
}

// Schema names are config-derived, never user input, but quoting via
// format() (not a bound parameter - Postgres doesn't allow identifiers as
// query params) still guards against a stray special character in a
// misconfigured env var.
function qualify(schema: string, table: string): string {
  return `"${schema.replace(/"/g, '""')}"."${table}"`;
}

export async function getPersonaSystemPrompt(config: Config, name = "Amy"): Promise<string | undefined> {
  const result = await getPool(config).query<{ system_prompt: string }>(
    `SELECT system_prompt FROM ${qualify(config.dbSchema, "personas")} WHERE name = $1 LIMIT 1`,
    [name],
  );
  return result.rows[0]?.system_prompt;
}

export interface ActiveSkillRow {
  name: string;
  description: string;
  instructions: string;
}

export async function getActiveInstructionSkills(config: Config): Promise<ActiveSkillRow[]> {
  const result = await getPool(config).query<ActiveSkillRow>(
    `SELECT name, description, instructions FROM ${qualify(config.dbSchema, "skills")}
     WHERE status = 'active' AND kind = 'instruction'`,
  );
  return result.rows;
}
