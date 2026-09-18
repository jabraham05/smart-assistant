-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d research < postgres/init/08-create-knowledge-tables.sql
\connect research

CREATE EXTENSION IF NOT EXISTS vector; -- idempotent, already present from 02-create-research-db.sql

-- Owned by knowledge-engine, replacing research_documents/research_chunks/
-- research_log (left alone, unmigrated - see docs/knowledge-engine.md).
-- One shape for everything: an ingested manual, a saved web page, or a
-- synthesized research write-up are all just a documents row with a
-- different source_type/kind. Domain is metadata, never a separate table
-- or separate code path - the whole point is treating a Porsche wiring
-- diagram and a Warframe build guide the same way.
CREATE TABLE documents (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind               TEXT NOT NULL DEFAULT 'reference', -- 'reference' | 'research'
  source_type        TEXT NOT NULL,                      -- 'pdf' | 'url' | 'text' | 'web_research'
  title              TEXT,
  domain             TEXT,                                -- 'automotive' | 'warframe' | 'general' | ...
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- make/model/year/system, category/weapon, etc.
  markdown           TEXT,                                 -- present for 'research' kind (synthesized doc)
  origin_url         TEXT,
  version            TEXT,
  valid_from         TIMESTAMPTZ,
  valid_until        TIMESTAMPTZ,
  retrieved_at       TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'running',      -- running | complete | failed
  trigger_source     TEXT NOT NULL DEFAULT 'chat',         -- chat | gap_scanner | ingest_script
  origin_session_id  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_origin_session_idx ON documents (origin_session_id);
CREATE INDEX documents_domain_idx ON documents (domain);
CREATE INDEX documents_metadata_idx ON documents USING GIN (metadata);

-- First-class provenance objects, the direct fix for research_chunks'
-- biggest gap (only a flat source_urls array on the whole document, no way
-- to tell which chunk came from which URL). A document can span several
-- sources (multiple web pages folded into one research doc); a chunk
-- points at exactly one.
CREATE TABLE sources (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  url             TEXT,
  title           TEXT,
  authority_tier  TEXT,          -- domain-skill-defined, e.g. 'primary'|'community'|'unknown'
  published_at    TIMESTAMPTZ,
  retrieved_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sources_document_idx ON sources (document_id);

CREATE TABLE chunks (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id    BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_id      BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  chunk_index    INTEGER NOT NULL,
  heading        TEXT,
  page_number    INTEGER,
  section_path   TEXT,           -- e.g. "Chapter 4 > Fuel System > Injectors"
  content        TEXT NOT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb, -- inherits/overrides document metadata
  embedding      VECTOR(768) NOT NULL,               -- matches nomic-embed-text's output dimension
  content_tsv    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_tsv_idx ON chunks USING GIN (content_tsv);
CREATE INDEX chunks_metadata_idx ON chunks USING GIN (metadata);
CREATE INDEX chunks_document_idx ON chunks (document_id);

-- Persistent research sessions (Phase 4 of docs/knowledge-engine.md) -
-- findings/citations survive independently of the final markdown blob, so
-- "what did we learn about X" and "where did sources disagree" both work
-- weeks later, not just immediately after a research run finishes.
CREATE TABLE research_sessions (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic              TEXT NOT NULL,
  domain             TEXT,
  status             TEXT NOT NULL DEFAULT 'running',
  trigger_source     TEXT NOT NULL DEFAULT 'chat',
  origin_session_id  TEXT,
  document_id        BIGINT REFERENCES documents(id), -- the saved write-up, once remember() runs
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE findings (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  research_session_id  BIGINT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  claim                TEXT NOT NULL,
  confidence           TEXT NOT NULL DEFAULT 'single_source', -- confirmed | contested | single_source
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE citations (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id   BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  source_id    BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  excerpt      TEXT NOT NULL,
  supports     BOOLEAN NOT NULL DEFAULT true, -- false = this source contradicts the claim
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only, and (unlike the old research_log, which nothing ever wrote
-- to) actually written to.
CREATE TABLE knowledge_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id  BIGINT REFERENCES documents(id) ON DELETE CASCADE,
  session_id   BIGINT REFERENCES research_sessions(id) ON DELETE CASCADE,
  phase        TEXT NOT NULL,
  content      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
