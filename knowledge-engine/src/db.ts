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
  keyword_overlap_count: number;
  query_lexeme_count: number;
}

export interface HybridSearchOptions {
  queryEmbedding: number[];
  queryText: string;
  domain?: string;
  metadataFilter?: Record<string, unknown>;
  includeStale?: boolean;
  topK?: number;
  // From the domain's domain_skills.freshness_required (see
  // engine/domain-skills.ts) - when true, a third ranked list orders
  // candidates by how recently they were retrieved/ingested and fuses it
  // in via the same RRF mechanism as vector/keyword, so a fresher
  // otherwise-similar chunk outranks a stale one. Off by default: most
  // domains (a car's wiring diagram doesn't go stale) shouldn't have
  // recency silently affecting ranking at all.
  useRecencyRanking?: boolean;
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
    `WITH query_lexemes AS (
       -- Real, non-trivial lexemes in the query, stemmed/stopword-filtered
       -- the same way content_tsv already is - lets the final SELECT check
       -- genuine keyword overlap per result without a second round trip.
       -- length >= 3 drops noise fragments (e.g. a stray "r" from "GT-R").
       SELECT ARRAY(
         SELECT lex FROM unnest(tsvector_to_array(to_tsvector('english', $4))) AS lex
         WHERE length(lex) >= 3
       ) AS lexemes
     ),
     vector_ranked AS (
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
     recency_ranked AS (
       SELECT c.id, ROW_NUMBER() OVER (ORDER BY COALESCE(d.retrieved_at, d.created_at) DESC) AS rank
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE $9::boolean
         AND d.status = 'complete'
         AND ($2::text IS NULL OR d.domain = $2)
         AND d.metadata @> $3::jsonb
         AND ($5::boolean OR d.valid_until IS NULL OR d.valid_until > now())
       ORDER BY COALESCE(d.retrieved_at, d.created_at) DESC
       LIMIT $6
     ),
     combined AS (
       SELECT id, SUM(1.0 / ($7 + rank)) AS rrf_score
       FROM (
         SELECT * FROM vector_ranked
         UNION ALL SELECT * FROM keyword_ranked
         UNION ALL SELECT * FROM recency_ranked
       ) all_ranked
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
       combined.rrf_score,
       COALESCE(array_length(
         ARRAY(
           SELECT unnest(query_lexemes.lexemes)
           INTERSECT
           SELECT unnest(tsvector_to_array(c.content_tsv))
         ),
       1), 0) AS keyword_overlap_count,
       COALESCE(array_length(query_lexemes.lexemes, 1), 0) AS query_lexeme_count
     FROM combined
     JOIN chunks c ON c.id = combined.id
     JOIN documents d ON d.id = c.document_id
     LEFT JOIN sources s ON s.id = c.source_id
     CROSS JOIN query_lexemes
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
      options.useRecencyRanking ?? false,
    ],
  );
  // node-pg returns NUMERIC/aggregate SUM columns as strings, not numbers,
  // to avoid silent precision loss - real bug caught live via
  // decideRoute's `topResult.score.toFixed is not a function` once a
  // caller actually tried to use rrf_score as a number instead of just
  // displaying it. Converting once here, at the query boundary, means every
  // caller can trust ChunkSearchRow.rrf_score's declared `number` type.
  return result.rows.map((row) => ({ ...row, rrf_score: Number(row.rrf_score) }));
}

// --- Phase 4: persistent research sessions ---

export interface ResearchSessionRow {
  id: number;
  topic: string;
  domain: string | null;
  status: string;
  trigger_source: string;
  origin_session_id: string | null;
  document_id: number | null;
  created_at: string;
  updated_at: string;
}

export async function insertResearchSession(
  config: Config,
  input: { topic: string; domain?: string; triggerSource?: string; originSessionId?: string },
): Promise<ResearchSessionRow> {
  const result = await getPool(config).query<ResearchSessionRow>(
    `INSERT INTO research_sessions (topic, domain, trigger_source, origin_session_id, status)
     VALUES ($1, $2, $3, $4, 'running')
     RETURNING *`,
    [input.topic, input.domain || null, input.triggerSource || "chat", input.originSessionId || null],
  );
  return result.rows[0];
}

export async function updateResearchSessionStatus(
  config: Config,
  sessionId: number,
  status: string,
  documentId?: number,
): Promise<void> {
  await getPool(config).query(
    `UPDATE research_sessions SET status = $2, document_id = COALESCE($3, document_id), updated_at = now() WHERE id = $1`,
    [sessionId, status, documentId ?? null],
  );
}

export async function getLatestResearchSessionByOriginSession(
  config: Config,
  originSessionId: string,
): Promise<ResearchSessionRow | undefined> {
  const result = await getPool(config).query<ResearchSessionRow>(
    `SELECT * FROM research_sessions WHERE origin_session_id = $1 ORDER BY id DESC LIMIT 1`,
    [originSessionId],
  );
  return result.rows[0];
}

export interface FindingRow {
  id: number;
  research_session_id: number;
  claim: string;
  confidence: string;
  created_at: string;
}

export async function insertFinding(
  config: Config,
  input: { researchSessionId: number; claim: string; confidence: string },
): Promise<FindingRow> {
  const result = await getPool(config).query<FindingRow>(
    `INSERT INTO findings (research_session_id, claim, confidence) VALUES ($1, $2, $3) RETURNING *`,
    [input.researchSessionId, input.claim, input.confidence],
  );
  return result.rows[0];
}

export interface CitationRow {
  id: number;
  finding_id: number;
  source_id: number;
  excerpt: string;
  supports: boolean;
  created_at: string;
}

export async function insertCitation(
  config: Config,
  input: { findingId: number; sourceId: number; excerpt: string; supports: boolean },
): Promise<void> {
  await getPool(config).query(
    `INSERT INTO citations (finding_id, source_id, excerpt, supports) VALUES ($1, $2, $3, $4)`,
    [input.findingId, input.sourceId, input.excerpt, input.supports],
  );
}

// Finds an existing source row for this URL under this document, or
// creates one - findings only carry raw URLs, not source_id, so both
// persist-research.ts (linking a finding's citations) and its own chunk
// insert need to resolve the same URL to the same source row rather than
// creating a duplicate row per mention.
export async function getOrCreateSource(
  config: Config,
  documentId: number,
  url: string,
  title?: string,
): Promise<SourceRow> {
  const existing = await getPool(config).query<SourceRow>(
    `SELECT * FROM sources WHERE document_id = $1 AND url = $2 LIMIT 1`,
    [documentId, url],
  );
  if (existing.rows[0]) return existing.rows[0];
  return insertSource(config, { documentId, url, title });
}

export interface CitationDetail {
  source_url: string | null;
  source_title: string | null;
  excerpt: string;
  supports: boolean;
}

export interface FindingDetail {
  id: number;
  claim: string;
  confidence: string;
  citations: CitationDetail[];
}

export interface ResearchSessionDetail {
  session: ResearchSessionRow;
  findings: FindingDetail[];
}

// Powers GET /research/:id - the whole point of Phase 4: "what did we
// learn about X" needs to return real findings/citations weeks later, not
// just the flat markdown blob the old research_documents.markdown column
// held.
export async function getResearchSessionDetail(config: Config, sessionId: number): Promise<ResearchSessionDetail | undefined> {
  const sessionResult = await getPool(config).query<ResearchSessionRow>(`SELECT * FROM research_sessions WHERE id = $1`, [
    sessionId,
  ]);
  const session = sessionResult.rows[0];
  if (!session) return undefined;

  const findingsResult = await getPool(config).query<{ id: number; claim: string; confidence: string }>(
    `SELECT id, claim, confidence FROM findings WHERE research_session_id = $1 ORDER BY id`,
    [sessionId],
  );

  const findings: FindingDetail[] = [];
  for (const findingRow of findingsResult.rows) {
    const citationsResult = await getPool(config).query<CitationDetail>(
      `SELECT s.url AS source_url, s.title AS source_title, c.excerpt, c.supports
       FROM citations c JOIN sources s ON s.id = c.source_id
       WHERE c.finding_id = $1 ORDER BY c.id`,
      [findingRow.id],
    );
    findings.push({ ...findingRow, citations: citationsResult.rows });
  }

  return { session, findings };
}

// --- Phase 5: domain skills (database-backed policy config) ---

export interface DomainSkillRow {
  domain: string;
  source_priority: string[];
  freshness_required: boolean;
  version_field: string | null;
  notes: string | null;
}

// No row for a domain is a normal, expected case (most domains have no
// special policy yet) - callers get undefined and fall back to the
// deterministic default (see engine/domain-skills.ts), not an error.
export async function getDomainSkill(config: Config, domain: string): Promise<DomainSkillRow | undefined> {
  const result = await getPool(config).query<DomainSkillRow>(`SELECT * FROM domain_skills WHERE domain = $1`, [domain]);
  return result.rows[0];
}
