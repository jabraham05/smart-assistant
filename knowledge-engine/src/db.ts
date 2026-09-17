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

export interface DocumentRow {
  id: number;
  kind: string;
  source_type: string;
  title: string | null;
  domain: string | null;
  metadata: Record<string, unknown>;
  markdown: string | null;
  origin_url: string | null;
  version: string | null;
  valid_from: string | null;
  valid_until: string | null;
  retrieved_at: string | null;
  status: string;
  trigger_source: string;
  origin_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertDocumentInput {
  kind?: string;
  sourceType: string;
  title?: string;
  domain?: string;
  metadata?: Record<string, unknown>;
  originUrl?: string;
  status?: string;
  triggerSource?: string;
  originSessionId?: string;
}

export async function insertDocument(config: Config, input: InsertDocumentInput): Promise<DocumentRow> {
  const result = await getPool(config).query<DocumentRow>(
    `INSERT INTO documents (kind, source_type, title, domain, metadata, origin_url, status, trigger_source, origin_session_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.kind || "reference",
      input.sourceType,
      input.title || null,
      input.domain || null,
      JSON.stringify(input.metadata || {}),
      input.originUrl || null,
      input.status || "running",
      input.triggerSource || "chat",
      input.originSessionId || null,
    ],
  );
  return result.rows[0];
}

export async function updateDocumentStatus(config: Config, documentId: number, status: string): Promise<void> {
  await getPool(config).query(`UPDATE documents SET status = $2, updated_at = now() WHERE id = $1`, [
    documentId,
    status,
  ]);
}

export async function getDocument(config: Config, documentId: number): Promise<DocumentRow | undefined> {
  const result = await getPool(config).query<DocumentRow>(`SELECT * FROM documents WHERE id = $1`, [documentId]);
  return result.rows[0];
}

export interface SourceRow {
  id: number;
  document_id: number;
  url: string | null;
  title: string | null;
  authority_tier: string | null;
  published_at: string | null;
  retrieved_at: string | null;
  created_at: string;
}

export interface InsertSourceInput {
  documentId: number;
  url?: string;
  title?: string;
  authorityTier?: string;
  publishedAt?: string;
}

export async function insertSource(config: Config, input: InsertSourceInput): Promise<SourceRow> {
  const result = await getPool(config).query<SourceRow>(
    `INSERT INTO sources (document_id, url, title, authority_tier, published_at, retrieved_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING *`,
    [input.documentId, input.url || null, input.title || null, input.authorityTier || null, input.publishedAt || null],
  );
  return result.rows[0];
}

export interface ChunkRow {
  id: number;
  document_id: number;
  source_id: number | null;
  chunk_index: number;
  heading: string | null;
  page_number: number | null;
  section_path: string | null;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface InsertChunkInput {
  documentId: number;
  sourceId?: number;
  chunkIndex: number;
  heading?: string;
  pageNumber?: number;
  sectionPath?: string;
  content: string;
  metadata?: Record<string, unknown>;
  embedding: number[];
}

export async function insertChunk(config: Config, input: InsertChunkInput): Promise<void> {
  await getPool(config).query(
    `INSERT INTO chunks (document_id, source_id, chunk_index, heading, page_number, section_path, content, metadata, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::vector)`,
    [
      input.documentId,
      input.sourceId || null,
      input.chunkIndex,
      input.heading || null,
      input.pageNumber || null,
      input.sectionPath || null,
      input.content,
      JSON.stringify(input.metadata || {}),
      `[${input.embedding.join(",")}]`,
    ],
  );
}

// Joined view used by search() (Phase 1c/1d) - every field a citation needs
// (page/section/source url/title) comes back in one query, no N+1 lookups.
export interface ChunkSearchRow {
  chunk_id: number;
  content: string;
  heading: string | null;
  page_number: number | null;
  section_path: string | null;
  document_id: number;
  document_title: string | null;
  domain: string | null;
  source_url: string | null;
  source_title: string | null;
  rrf_score: number;
}

export interface HybridSearchOptions {
  queryEmbedding: number[];
  queryText: string;
  domain?: string;
  metadataFilter?: Record<string, unknown>;
  includeStale?: boolean;
  topK?: number;
}

// Reciprocal Rank Fusion (constant k=60, the standard default from the
// original RRF paper) combining vector cosine and keyword (ts_rank)
// ranking, rather than a weighted sum of the two raw scores - cosine
// similarity and ts_rank live on incomparable scales, so fusing by rank
// position avoids needing hand-tuned weights entirely. Metadata/domain/
// freshness filters are a hard WHERE pre-filter applied identically to both
// candidate lists, not part of the ranking itself.
export async function hybridSearchChunks(config: Config, options: HybridSearchOptions): Promise<ChunkSearchRow[]> {
  const topK = options.topK ?? 5;
  const candidateLimit = Math.max(topK * 4, 20);
  const RRF_K = 60;

  const result = await getPool(config).query<ChunkSearchRow>(
    `WITH vector_ranked AS (
       SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.status = 'complete'
         AND ($2::text IS NULL OR d.domain = $2)
         AND d.metadata @> $3::jsonb
         AND ($5::boolean OR d.valid_until IS NULL OR d.valid_until > now())
       ORDER BY c.embedding <=> $1::vector
       LIMIT $6
     ),
     keyword_ranked AS (
       SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.content_tsv, plainto_tsquery('english', $4)) DESC) AS rank
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.status = 'complete'
         AND ($2::text IS NULL OR d.domain = $2)
         AND d.metadata @> $3::jsonb
         AND ($5::boolean OR d.valid_until IS NULL OR d.valid_until > now())
         AND c.content_tsv @@ plainto_tsquery('english', $4)
       ORDER BY ts_rank(c.content_tsv, plainto_tsquery('english', $4)) DESC
       LIMIT $6
     ),
     combined AS (
       SELECT id, SUM(1.0 / ($7 + rank)) AS rrf_score
       FROM (SELECT * FROM vector_ranked UNION ALL SELECT * FROM keyword_ranked) all_ranked
       GROUP BY id
     )
     SELECT
       c.id AS chunk_id,
       c.content,
       c.heading,
       c.page_number,
       c.section_path,
       d.id AS document_id,
       d.title AS document_title,
       d.domain,
       s.url AS source_url,
       s.title AS source_title,
       combined.rrf_score
     FROM combined
     JOIN chunks c ON c.id = combined.id
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN sources s ON s.id = c.source_id
     ORDER BY combined.rrf_score DESC
     LIMIT $8`,
    [
      `[${options.queryEmbedding.join(",")}]`,
      options.domain ?? null,
      JSON.stringify(options.metadataFilter ?? {}),
      options.queryText,
      options.includeStale ?? false,
      candidateLimit,
      RRF_K,
      topK,
    ],
  );
  return result.rows;
}
