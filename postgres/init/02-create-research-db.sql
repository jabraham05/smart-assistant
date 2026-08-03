-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). If this volume already existed before this file was added, apply it
-- manually instead:
--   docker compose exec -i postgres psql -U assistant -d postgres -c "CREATE DATABASE research OWNER assistant;"
--   docker compose exec -i postgres psql -U assistant -d research < postgres/init/02-create-research-db.sql
CREATE DATABASE research OWNER assistant;

\connect research

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE research_documents (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic              TEXT NOT NULL,
  title              TEXT,
  markdown           TEXT,
  source_urls        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 'chat' (started from a conversation) or 'gap_scanner' (auto-triggered by
  -- skill_gap_scanner on a detected knowledge gap, see n8n/workflows/skillgapscan001x.json)
  trigger_source     TEXT NOT NULL DEFAULT 'chat',
  origin_session_id  TEXT,
  status             TEXT NOT NULL DEFAULT 'running', -- running | complete | failed
  latest_status      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX research_documents_origin_session_idx ON research_documents (origin_session_id);

CREATE TABLE research_chunks (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id   BIGINT NOT NULL REFERENCES research_documents(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  heading       TEXT,
  content       TEXT NOT NULL,
  embedding     VECTOR(768) NOT NULL, -- matches nomic-embed-text's output dimension
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX research_chunks_embedding_idx
  ON research_chunks USING hnsw (embedding vector_cosine_ops);

-- Append-only transcript log, mirroring codingtasklog01's role in the
-- coding-agent pipeline — an audit trail for what happened during a research
-- run, useful for debugging autonomous (gap_scanner-triggered) research in
-- particular since there's no chat session to review otherwise.
CREATE TABLE research_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES research_documents(id) ON DELETE CASCADE,
  phase           TEXT NOT NULL,
  content         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
