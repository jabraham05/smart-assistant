import { Pool } from "pg";
import type { Config } from "./config.js";
import { getCodingTask } from "./lib/coding-orchestrator-client.js";

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
    [["documents", "sources", "chunks", "research_sessions", "findings", "citations", "knowledge_log", "entities"]],
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
  // Set once a linked project (engine/consolidate.ts) synthesizes a
  // write-up onto this session's document - null for a plain research run
  // that was never wrapped in a project, or one not yet consolidated.
  documentMarkdown: string | null;
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

  let documentMarkdown: string | null = null;
  if (session.document_id) {
    const document = await getDocument(config, session.document_id);
    documentMarkdown = document?.markdown ?? null;
  }

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

  return { session, findings, documentMarkdown };
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

// --- Self-learning research queue (engine/research-queue.ts) ---

export interface ResearchQueueRow {
  id: number;
  topic: string;
  domain: string | null;
  origin_session_id: string | null;
  trigger_source: string;
  status: string; // pending | researching | done | failed
  research_session_id: number | null;
  created_at: string;
  updated_at: string;
}

export async function countPendingResearchQueue(config: Config): Promise<number> {
  const result = await getPool(config).query<{ count: string }>(
    `SELECT COUNT(*) FROM research_queue WHERE status IN ('pending', 'researching')`,
  );
  return Number(result.rows[0].count);
}

// Fast, always-correct backstop for short/single-word topics where the
// lexeme-overlap check below can't reach its own minimum overlap floor
// (e.g. "guitar" is a single lexeme - a repeat of the exact same topic
// would never hit an overlap threshold of 2).
export async function findExactPendingTopic(config: Config, topic: string): Promise<ResearchQueueRow | undefined> {
  const result = await getPool(config).query<ResearchQueueRow>(
    `SELECT * FROM research_queue WHERE status IN ('pending', 'researching') AND lower(topic) = lower($1) LIMIT 1`,
    [topic],
  );
  return result.rows[0];
}

// Lexeme-overlap dedup, same technique as hybridSearchChunks()'s
// query_lexemes CTE above, applied topic-vs-topic instead of
// topic-vs-chunk-content. minOverlap is deliberately higher than
// minKeywordOverlap's document-search default of 1 (see config.ts) - topic
// strings are short and generic, so a single shared word is far more
// likely to be a coincidence here than against a full document chunk.
export async function findOverlappingPendingTopic(
  config: Config,
  topic: string,
  minOverlap: number,
): Promise<ResearchQueueRow | undefined> {
  const result = await getPool(config).query<ResearchQueueRow>(
    `WITH query_lexemes AS (
       SELECT ARRAY(
         SELECT lex FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lex
         WHERE length(lex) >= 3
       ) AS lexemes
     ),
     scored AS (
       SELECT rq.*, COALESCE(array_length(ARRAY(
         SELECT unnest(query_lexemes.lexemes)
         INTERSECT
         SELECT unnest(tsvector_to_array(rq.topic_tsv))
       ), 1), 0) AS overlap_count
       FROM research_queue rq
       CROSS JOIN query_lexemes
       WHERE rq.status IN ('pending', 'researching')
     )
     SELECT id, topic, domain, origin_session_id, trigger_source, status, research_session_id, created_at, updated_at
     FROM scored WHERE overlap_count >= $2
     ORDER BY overlap_count DESC LIMIT 1`,
    [topic, minOverlap],
  );
  return result.rows[0];
}

export async function insertResearchQueueEntry(
  config: Config,
  input: { topic: string; domain?: string; originSessionId?: string; triggerSource?: string },
): Promise<ResearchQueueRow> {
  const result = await getPool(config).query<ResearchQueueRow>(
    `INSERT INTO research_queue (topic, domain, origin_session_id, trigger_source, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [input.topic, input.domain || null, input.originSessionId || null, input.triggerSource || "chat"],
  );
  return result.rows[0];
}

export async function listResearchQueue(config: Config, status?: string): Promise<ResearchQueueRow[]> {
  if (status) {
    const result = await getPool(config).query<ResearchQueueRow>(
      `SELECT * FROM research_queue WHERE status = $1 ORDER BY created_at DESC`,
      [status],
    );
    return result.rows;
  }
  const result = await getPool(config).query<ResearchQueueRow>(`SELECT * FROM research_queue ORDER BY created_at DESC`);
  return result.rows;
}

// Atomic claim: a single UPDATE...WHERE IN (subquery) so a status flip and
// row selection can't race even if drainQueue is ever called concurrently
// (it isn't today - drains are sequential and triggered one at a time by a
// single wake event - but this is free correctness, not speculative).
export async function claimNextResearchQueueEntries(config: Config, limit: number): Promise<ResearchQueueRow[]> {
  const result = await getPool(config).query<ResearchQueueRow>(
    `UPDATE research_queue SET status = 'researching', updated_at = now()
     WHERE id IN (SELECT id FROM research_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1)
     RETURNING *`,
    [limit],
  );
  return result.rows;
}

export async function updateResearchQueueStatus(
  config: Config,
  id: number,
  status: string,
  researchSessionId?: number,
): Promise<void> {
  await getPool(config).query(
    `UPDATE research_queue SET status = $2, research_session_id = COALESCE($3, research_session_id), updated_at = now() WHERE id = $1`,
    [id, status, researchSessionId ?? null],
  );
}

// Real gap found via live testing: research_task_status only ever checked
// for a session tied to *this exact chat session* - background research
// queued ambiently (research-queue.ts) or drained hours/overnight later is
// invisible to a "what have you found out about X" follow-up asked from a
// different or later conversation, even though the research genuinely
// completed. These two lookups (any status, any session, most recent
// lexeme-overlap match) are the fix - same technique as
// findOverlappingPendingTopic above, generalized to search regardless of
// status/session.
export async function findResearchQueueByTopic(
  config: Config,
  topic: string,
  minOverlap: number,
): Promise<ResearchQueueRow | undefined> {
  const result = await getPool(config).query<ResearchQueueRow>(
    `WITH query_lexemes AS (
       SELECT ARRAY(
         SELECT lex FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lex
         WHERE length(lex) >= 3
       ) AS lexemes
     ),
     scored AS (
       SELECT rq.*, COALESCE(array_length(ARRAY(
         SELECT unnest(query_lexemes.lexemes)
         INTERSECT
         SELECT unnest(tsvector_to_array(rq.topic_tsv))
       ), 1), 0) AS overlap_count
       FROM research_queue rq
       CROSS JOIN query_lexemes
     )
     SELECT id, topic, domain, origin_session_id, trigger_source, status, research_session_id, created_at, updated_at
     FROM scored WHERE overlap_count >= $2
     ORDER BY overlap_count DESC, updated_at DESC LIMIT 1`,
    [topic, minOverlap],
  );
  return result.rows[0];
}

// --- Projects: human-approved autonomous learning/research efforts ---
// (engine/consolidate.ts, index.ts's /projects* routes)

export interface ProjectRow {
  id: number;
  title: string;
  rationale: string;
  domain: string | null;
  status: string; // proposed | active | done | rejected
  origin: string; // amy_proposed | user_requested
  activity_type: string; // research | coding
  research_queue_id: number | null;
  research_session_id: number | null;
  // Opaque reference into coding-orchestrator's own coding_tasks database -
  // no FK, resolved via that service's GET /tasks/:id, not a join.
  coding_task_id: number | null;
  target_repo_url: string | null; // coding only, optional
  document_id: number | null;
  created_at: string;
  approved_at: string | null;
  updated_at: string;
}

// Real bug found via live testing: duplicate projects got created for the
// same idea with no dedup at all - same lexeme-overlap technique as
// findOverlappingPendingTopic, computed on the fly (no stored tsvector
// column here, same tradeoff findResearchSessionByTopic already made).
// Only checks proposed/active projects - a done/rejected one shouldn't
// block proposing the same idea again later.
export async function findOverlappingProject(
  config: Config,
  title: string,
  minOverlap: number,
): Promise<ProjectRow | undefined> {
  const result = await getPool(config).query<ProjectRow>(
    `WITH query_lexemes AS (
       SELECT ARRAY(
         SELECT lex FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lex
         WHERE length(lex) >= 3
       ) AS lexemes
     ),
     scored AS (
       SELECT p.*, COALESCE(array_length(ARRAY(
         SELECT unnest(query_lexemes.lexemes)
         INTERSECT
         SELECT unnest(tsvector_to_array(to_tsvector('english', p.title)))
       ), 1), 0) AS overlap_count
       FROM projects p
       CROSS JOIN query_lexemes
       WHERE p.status IN ('proposed', 'active')
     )
     SELECT * FROM scored WHERE overlap_count >= $2
     ORDER BY overlap_count DESC, updated_at DESC LIMIT 1`,
    [title, minOverlap],
  );
  return result.rows[0];
}

export async function insertProject(
  config: Config,
  input: {
    title: string;
    rationale: string;
    domain?: string;
    origin?: string;
    activityType?: string;
    targetRepoUrl?: string;
  },
): Promise<ProjectRow> {
  const result = await getPool(config).query<ProjectRow>(
    `INSERT INTO projects (title, rationale, domain, origin, activity_type, target_repo_url, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'proposed')
     RETURNING *`,
    [
      input.title,
      input.rationale,
      input.domain || null,
      input.origin || "amy_proposed",
      input.activityType || "research",
      input.targetRepoUrl || null,
    ],
  );
  return result.rows[0];
}

export interface ProjectListRow extends ProjectRow {
  research_queue_status: string | null;
  // Not from the SQL join below (coding_tasks lives in a different
  // database) - filled in by listProjects after the query, one HTTP call
  // per coding-activity row, so the dashboard gets the same "researching..."
  // vs "ready to complete" parity for coding projects without the caller
  // having to cross-reference a separate coding-tasks list itself.
  coding_task_status: string | null;
  coding_task_pr_url: string | null;
}

// LEFT JOINs research_queue so the dashboard can show "researching..." vs
// "ready to complete" without a second round trip per research-activity
// project.
export async function listProjects(config: Config, status?: string): Promise<ProjectListRow[]> {
  const where = status ? `WHERE p.status = $1` : "";
  const params = status ? [status] : [];
  const result = await getPool(config).query<Omit<ProjectListRow, "coding_task_status" | "coding_task_pr_url">>(
    `SELECT p.*, rq.status AS research_queue_status
     FROM projects p
     LEFT JOIN research_queue rq ON rq.id = p.research_queue_id
     ${where}
     ORDER BY p.created_at DESC`,
    params,
  );

  const rows: ProjectListRow[] = await Promise.all(
    result.rows.map(async (row) => {
      if (row.activity_type !== "coding" || !row.coding_task_id) {
        return { ...row, coding_task_status: null, coding_task_pr_url: null };
      }
      try {
        const task = await getCodingTask(config, row.coding_task_id);
        return { ...row, coding_task_status: task?.status ?? null, coding_task_pr_url: task?.pr_url ?? null };
      } catch {
        return { ...row, coding_task_status: null, coding_task_pr_url: null };
      }
    }),
  );
  return rows;
}

export async function getProject(config: Config, id: number): Promise<ProjectRow | undefined> {
  const result = await getPool(config).query<ProjectRow>(`SELECT * FROM projects WHERE id = $1`, [id]);
  return result.rows[0];
}

export async function updateProject(
  config: Config,
  id: number,
  fields: Partial<{
    status: string;
    researchQueueId: number;
    researchSessionId: number;
    codingTaskId: number;
    documentId: number;
    approvedAt: Date;
  }>,
): Promise<ProjectRow | undefined> {
  const entries: [string, unknown][] = [];
  if (fields.status !== undefined) entries.push(["status", fields.status]);
  if (fields.researchQueueId !== undefined) entries.push(["research_queue_id", fields.researchQueueId]);
  if (fields.researchSessionId !== undefined) entries.push(["research_session_id", fields.researchSessionId]);
  if (fields.codingTaskId !== undefined) entries.push(["coding_task_id", fields.codingTaskId]);
  if (fields.documentId !== undefined) entries.push(["document_id", fields.documentId]);
  if (fields.approvedAt !== undefined) entries.push(["approved_at", fields.approvedAt]);
  if (entries.length === 0) return getProject(config, id);

  const setClauses = entries.map(([key], i) => `${key} = $${i + 2}`);
  const values = entries.map(([, value]) => value);
  const result = await getPool(config).query<ProjectRow>(
    `UPDATE projects SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return result.rows[0];
}

export async function getResearchQueueEntry(config: Config, id: number): Promise<ResearchQueueRow | undefined> {
  const result = await getPool(config).query<ResearchQueueRow>(`SELECT * FROM research_queue WHERE id = $1`, [id]);
  return result.rows[0];
}

export async function setDocumentMarkdown(config: Config, documentId: number, markdown: string): Promise<void> {
  await getPool(config).query(`UPDATE documents SET markdown = $2, updated_at = now() WHERE id = $1`, [
    documentId,
    markdown,
  ]);
}

export async function findResearchSessionByTopic(
  config: Config,
  topic: string,
  minOverlap: number,
): Promise<ResearchSessionRow | undefined> {
  const result = await getPool(config).query<ResearchSessionRow>(
    `WITH query_lexemes AS (
       SELECT ARRAY(
         SELECT lex FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lex
         WHERE length(lex) >= 3
       ) AS lexemes
     ),
     scored AS (
       SELECT rs.*, COALESCE(array_length(ARRAY(
         SELECT unnest(query_lexemes.lexemes)
         INTERSECT
         SELECT unnest(tsvector_to_array(to_tsvector('english', rs.topic)))
       ), 1), 0) AS overlap_count
       FROM research_sessions rs
       CROSS JOIN query_lexemes
     )
     SELECT id, topic, domain, status, trigger_source, origin_session_id, document_id, created_at, updated_at
     FROM scored WHERE overlap_count >= $2
     ORDER BY overlap_count DESC, updated_at DESC LIMIT 1`,
    [topic, minOverlap],
  );
  return result.rows[0];
}

// Phase 1 of the "Amy's world" rework (23-create-entities-table.sql) - a
// registry of durable things, independent of which table/service produced
// them. See engine/entities.ts for the file-write half of entity creation.
export interface EntityRow {
  id: string;
  type: string;
  name: string;
  description: string | null;
  status: string | null;
  source_table: string | null;
  source_id: string | null;
  source_path: string | null;
  graphiti_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function insertEntity(
  config: Config,
  input: {
    type: string;
    name: string;
    description?: string;
    status?: string;
    sourceTable?: string;
    sourceId?: string;
    sourcePath?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<EntityRow> {
  const result = await getPool(config).query<EntityRow>(
    `INSERT INTO entities (type, name, description, status, source_table, source_id, source_path, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      input.type,
      input.name,
      input.description || null,
      input.status || null,
      input.sourceTable || null,
      input.sourceId || null,
      input.sourcePath || null,
      JSON.stringify(input.metadata || {}),
    ],
  );
  return result.rows[0];
}

export async function getEntity(config: Config, id: string): Promise<EntityRow | undefined> {
  const result = await getPool(config).query<EntityRow>(`SELECT * FROM entities WHERE id = $1`, [id]);
  return result.rows[0];
}

export async function listEntities(config: Config, type?: string): Promise<EntityRow[]> {
  const where = type ? `WHERE type = $1` : "";
  const params = type ? [type] : [];
  const result = await getPool(config).query<EntityRow>(
    `SELECT * FROM entities ${where} ORDER BY created_at DESC`,
    params,
  );
  return result.rows;
}

export async function updateEntity(
  config: Config,
  id: string,
  fields: Partial<{
    status: string;
    description: string;
    sourcePath: string;
    graphitiId: string;
    metadata: Record<string, unknown>;
  }>,
): Promise<EntityRow | undefined> {
  const entries: [string, unknown][] = [];
  if (fields.status !== undefined) entries.push(["status", fields.status]);
  if (fields.description !== undefined) entries.push(["description", fields.description]);
  if (fields.sourcePath !== undefined) entries.push(["source_path", fields.sourcePath]);
  if (fields.graphitiId !== undefined) entries.push(["graphiti_id", fields.graphitiId]);
  if (fields.metadata !== undefined) entries.push(["metadata", JSON.stringify(fields.metadata)]);
  if (entries.length === 0) return getEntity(config, id);

  const setClauses = entries.map(([key], i) => (key === "metadata" ? `${key} = $${i + 2}::jsonb` : `${key} = $${i + 2}`));
  const values = entries.map(([, value]) => value);
  const result = await getPool(config).query<EntityRow>(
    `UPDATE entities SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return result.rows[0];
}
