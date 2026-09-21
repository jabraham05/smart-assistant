-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). If this volume already existed before this file was added, apply it
-- manually instead:
--   docker compose exec -i postgres psql -U assistant -d postgres -c "CREATE DATABASE memory OWNER assistant;"
--   docker compose exec -i postgres psql -U assistant -d memory < postgres/init/13-create-memory-db.sql
CREATE DATABASE memory OWNER assistant;

\connect memory

CREATE EXTENSION IF NOT EXISTS vector;

-- Owned by memory-engine. Deliberately its own database, not a new
-- domain inside knowledge-engine's `research` database (documents/
-- chunks) - knowledge-engine's own docs already scope it to world facts
-- (cars, docs, research), explicitly out of scope for user-specific
-- memory; mixing personal conversation data into that store, even as a
-- same-table different-domain row, would blur a boundary this project
-- has kept clean everywhere else. Every turn from a chat-orchestrator
-- session is stored here unconditionally (no should_save gate yet - see
-- the architecture plan's Phase 7 for that refinement).
CREATE TABLE memory_entries (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id    TEXT NOT NULL,
  role          TEXT NOT NULL,                        -- 'user' | 'assistant'
  content       TEXT NOT NULL,
  embedding     VECTOR(768) NOT NULL,                 -- matches nomic-embed-text's output dimension
  content_tsv   TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX memory_entries_embedding_idx ON memory_entries USING hnsw (embedding vector_cosine_ops);
CREATE INDEX memory_entries_content_tsv_idx ON memory_entries USING GIN (content_tsv);
CREATE INDEX memory_entries_session_id_idx ON memory_entries (session_id);
