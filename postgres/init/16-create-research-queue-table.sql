-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d research < postgres/init/16-create-research-queue-table.sql
\connect research

-- Backs the self-learning research queue: topics Amy noticed she doesn't
-- know much about (or a newly created goal) get queued here, then drained
-- during idle/overnight time by calling the same checkKnowledge/
-- runWebResearchAndPersist pipeline `POST /research` already uses - see
-- engine/research-queue.ts. Deliberately lives in this database, not
-- event-bus's `events` DB: a queue row graduates directly into a
-- research_sessions row in this same database once drained, and the drain
-- job needs direct in-process access to engine/research.ts's functions.
CREATE TABLE IF NOT EXISTS research_queue (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic               TEXT NOT NULL,
  -- Generated tsvector for cheap lexeme-overlap dedup against other queued
  -- topics before insert - same technique as db.ts's hybridSearchChunks()
  -- query_lexemes CTE, reused here instead of a second embedding-similarity
  -- codepath since topic strings are short.
  topic_tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', topic)) STORED,
  domain              TEXT,
  origin_session_id   TEXT,
  trigger_source      TEXT NOT NULL DEFAULT 'chat', -- chat | goal_created | research_queue
  status              TEXT NOT NULL DEFAULT 'pending', -- pending | researching | done | failed
  research_session_id BIGINT REFERENCES research_sessions(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_queue_status_idx ON research_queue (status, created_at);
CREATE INDEX IF NOT EXISTS research_queue_topic_tsv_idx ON research_queue USING GIN (topic_tsv);
