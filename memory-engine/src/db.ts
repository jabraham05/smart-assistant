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
  domain: string | null;
  task_context_id: number | null;
  created_at: string;
}

export interface InsertMemoryEntryInput {
  sessionId: string;
  role: string;
  content: string;
  embedding: number[];
  domain?: string;
  taskContextId?: number;
}

export async function insertMemoryEntry(config: Config, input: InsertMemoryEntryInput): Promise<MemoryEntryRow> {
  const result = await getPool(config).query<MemoryEntryRow>(
    `INSERT INTO memory_entries (session_id, role, content, embedding, domain, task_context_id)
     VALUES ($1, $2, $3, $4::vector, $5, $6)
     RETURNING id, session_id, role, content, domain, task_context_id, created_at`,
    [
      input.sessionId,
      input.role,
      input.content,
      `[${input.embedding.join(",")}]`,
      input.domain ?? null,
      input.taskContextId ?? null,
    ],
  );
  return result.rows[0];
}

export interface MemorySearchRow extends MemoryEntryRow {
  rrf_score: number;
  // Real keyword overlap between the query and this result's content, and
  // how many significant lexemes the query itself had - same fields
  // knowledge-engine's hybridSearchChunks exposes, for the same reason
  // (see its router.ts's decideRoute): the recency-ranked list here means
  // a completely unrelated-but-recent memory can still land a nonzero RRF
  // score, so callers deciding whether to actually inject a result need a
  // second, non-vector signal alongside the score.
  keyword_overlap_count: number;
  query_lexeme_count: number;
}

export interface HybridSearchOptions {
  topK: number;
  // Hard WHERE pre-filters, applied identically to all three candidate
  // lists before ranking - same convention as knowledge-engine's
  // domain/metadata filters. Both optional: the automatic per-turn
  // retrieval deliberately leaves these unset (a personal preference can
  // be relevant regardless of what capability the current message
  // classified into); memory_recall's manual path can set taskContextId
  // to scope a lookup to one task's own timeline.
  domain?: string;
  taskContextId?: number;
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
  options: HybridSearchOptions,
): Promise<MemorySearchRow[]> {
  const { topK, domain, taskContextId } = options;
  const candidateLimit = Math.max(topK * 4, 20);
  const RRF_K = 60;

  const result = await getPool(config).query<MemorySearchRow>(
    `WITH query_lexemes AS (
       -- Same technique as knowledge-engine's hybridSearchChunks: real,
       -- non-trivial lexemes in the query, stemmed/stopword-filtered the
       -- same way content_tsv already is, so the final SELECT can check
       -- genuine keyword overlap per result without a second round trip.
       SELECT ARRAY(
         SELECT lex FROM unnest(tsvector_to_array(to_tsvector('english', $2))) AS lex
         WHERE length(lex) >= 3
       ) AS lexemes
     ),
     vector_ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
       FROM memory_entries
       WHERE ($6::text IS NULL OR domain = $6) AND ($7::bigint IS NULL OR task_context_id = $7)
       ORDER BY embedding <=> $1::vector
       LIMIT $4
     ),
     keyword_ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $2)) DESC) AS rank
       FROM memory_entries
       WHERE content_tsv @@ plainto_tsquery('english', $2)
         AND ($6::text IS NULL OR domain = $6) AND ($7::bigint IS NULL OR task_context_id = $7)
       ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $2)) DESC
       LIMIT $4
     ),
     recency_ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rank
       FROM memory_entries
       WHERE ($6::text IS NULL OR domain = $6) AND ($7::bigint IS NULL OR task_context_id = $7)
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
     SELECT
       m.id, m.session_id, m.role, m.content, m.domain, m.task_context_id, m.created_at, combined.rrf_score,
       COALESCE(array_length(
         ARRAY(
           SELECT unnest(query_lexemes.lexemes)
           INTERSECT
           SELECT unnest(tsvector_to_array(m.content_tsv))
         ),
       1), 0) AS keyword_overlap_count,
       COALESCE(array_length(query_lexemes.lexemes, 1), 0) AS query_lexeme_count
     FROM combined
     JOIN memory_entries m ON m.id = combined.id
     CROSS JOIN query_lexemes
     ORDER BY combined.rrf_score DESC
     LIMIT $3`,
    [`[${queryEmbedding.join(",")}]`, queryText, topK, candidateLimit, RRF_K, domain ?? null, taskContextId ?? null],
  );
  // node-pg returns the SUM aggregate as a string, not a number, to avoid
  // silent precision loss - same real gotcha knowledge-engine's db.ts
  // already documents for the identical RRF query shape.
  return result.rows.map((r) => ({ ...r, rrf_score: Number(r.rrf_score) }));
}
