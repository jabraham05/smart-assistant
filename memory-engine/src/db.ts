import { Pool } from "pg";
import type { Config } from "./config.js";

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

export interface MemoryEntryRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface InsertMemoryEntryInput {
  sessionId: string;
  role: string;
  content: string;
  embedding: number[];
}

export async function insertMemoryEntry(config: Config, input: InsertMemoryEntryInput): Promise<MemoryEntryRow> {
  const result = await getPool(config).query<MemoryEntryRow>(
    `INSERT INTO memory_entries (session_id, role, content, embedding)
     VALUES ($1, $2, $3, $4::vector)
     RETURNING id, session_id, role, content, created_at`,
    [input.sessionId, input.role, input.content, `[${input.embedding.join(",")}]`],
  );
  return result.rows[0];
}

export interface MemorySearchRow extends MemoryEntryRow {
  rrf_score: number;
}

// Hybrid RRF (constant k=60, standard from the original paper) fusing
// vector-cosine, keyword (ts_rank), and recency ranking - adapted
// directly from knowledge-engine's hybridSearchChunks (its own comment
// there explains the RRF-over-weighted-sum reasoning: cosine similarity
// and ts_rank live on incomparable scales, so fusing by rank position
// avoids hand-tuned weights). Recency is unconditionally in the mix here
// (unlike knowledge-engine's optional useRecencyRanking) - a recent
// mention of something is usually more relevant to *this* conversation
// than an old one, which isn't true for knowledge-engine's world-facts
// domains (a wiring diagram doesn't go stale).
export async function hybridSearchMemory(
  config: Config,
  queryEmbedding: number[],
  queryText: string,
  topK: number,
): Promise<MemorySearchRow[]> {
  const candidateLimit = Math.max(topK * 4, 20);
  const RRF_K = 60;

  const result = await getPool(config).query<MemorySearchRow>(
    `WITH vector_ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
       FROM memory_entries
       ORDER BY embedding <=> $1::vector
       LIMIT $4
     ),
     keyword_ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $2)) DESC) AS rank
       FROM memory_entries
       WHERE content_tsv @@ plainto_tsquery('english', $2)
       ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $2)) DESC
       LIMIT $4
     ),
     recency_ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rank
       FROM memory_entries
       ORDER BY created_at DESC
       LIMIT $4
     ),
     combined AS (
       SELECT id, SUM(1.0 / ($5 + rank)) AS rrf_score
       FROM (
         SELECT * FROM vector_ranked
         UNION ALL SELECT * FROM keyword_ranked
         UNION ALL SELECT * FROM recency_ranked
       ) all_ranked
       GROUP BY id
     )
     SELECT m.id, m.session_id, m.role, m.content, m.created_at, combined.rrf_score
     FROM combined
     JOIN memory_entries m ON m.id = combined.id
     ORDER BY combined.rrf_score DESC
     LIMIT $3`,
    [`[${queryEmbedding.join(",")}]`, queryText, topK, candidateLimit, RRF_K],
  );
  // node-pg returns the SUM aggregate as a string, not a number, to avoid
  // silent precision loss - same real gotcha knowledge-engine's db.ts
  // already documents for the identical RRF query shape.
  return result.rows.map((r) => ({ ...r, rrf_score: Number(r.rrf_score) }));
}
