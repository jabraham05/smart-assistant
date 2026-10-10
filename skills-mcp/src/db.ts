import { Pool } from "pg";
import type { Config } from "./config.js";

export interface SkillProposalRow {
  id: number;
  kind: "instruction" | "tool_idea";
  name: string;
  description: string;
  reason: string;
  instructions: string | null;
  tool_idea_details: string | null;
  status: "proposed" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
}

export interface InsertSkillProposalInput {
  kind: "instruction" | "tool_idea";
  name: string;
  description: string;
  reason: string;
  instructions?: string;
  tool_idea_details?: string;
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

export async function insertSkillProposal(
  config: Config,
  input: InsertSkillProposalInput,
): Promise<SkillProposalRow> {
  const result = await getPool(config).query<SkillProposalRow>(
    `INSERT INTO skill_proposals (kind, name, description, reason, instructions, tool_idea_details)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.kind, input.name, input.description, input.reason, input.instructions || null, input.tool_idea_details || null],
  );
  return result.rows[0];
}

export async function listSkillProposals(config: Config, status?: string): Promise<SkillProposalRow[]> {
  if (status) {
    const result = await getPool(config).query<SkillProposalRow>(
      `SELECT * FROM skill_proposals WHERE status = $1 ORDER BY created_at DESC`,
      [status],
    );
    return result.rows;
  }
  const result = await getPool(config).query<SkillProposalRow>(`SELECT * FROM skill_proposals ORDER BY created_at DESC`);
  return result.rows;
}

export async function getSkillProposal(config: Config, id: number): Promise<SkillProposalRow | undefined> {
  const result = await getPool(config).query<SkillProposalRow>(`SELECT * FROM skill_proposals WHERE id = $1`, [id]);
  return result.rows[0];
}

// skill_metadata (postgres/init/26-create-skill-metadata-table.sql) lives
// in this same `skills` database - L4 examples on demand, the natural
// agentic equivalent of "drill into this skill further" now that there's
// no single-pass way to inject every level for every matched skill (see
// agent-service/src/skills_discovery.py).
export async function getSkillExamples(config: Config, skillName: string): Promise<string | undefined> {
  const result = await getPool(config).query<{ level4_examples: string | null }>(
    `SELECT level4_examples FROM skill_metadata WHERE skill_name = $1`,
    [skillName],
  );
  return result.rows[0]?.level4_examples ?? undefined;
}

export async function updateSkillProposalStatus(
  config: Config,
  id: number,
  status: "approved" | "rejected",
): Promise<SkillProposalRow> {
  const result = await getPool(config).query<SkillProposalRow>(
    `UPDATE skill_proposals SET status = $2, reviewed_at = now() WHERE id = $1 RETURNING *`,
    [id, status],
  );
  return result.rows[0];
}
