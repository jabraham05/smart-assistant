-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d research < postgres/init/23-create-entities-table.sql
\connect research

-- Phase 1 of the "Amy's world" rework: a registry of durable things,
-- independent of which table/service produced them, each optionally backed
-- by a human-readable file under knowledge-engine's KNOWLEDGE_STORE_PATH
-- (see engine/entities.ts) and/or a Graphiti episode. Lives in `research`
-- since knowledge-engine already owns this database and is the first
-- (only, for now) writer - see docs/knowledge-engine.md.
--
-- source_table/source_id point back at the row this entity mirrors (e.g.
-- 'projects'/'42') rather than this table replacing projects/skill_proposals
-- outright - that unification is a later phase, not this one. source_id is
-- TEXT because source tables use different id types (projects is a BIGINT
-- serial; a future source might use a UUID).
--
-- No CHECK constraint on type/status - same free-text convention as
-- findings.confidence (08-create-knowledge-tables.sql) and
-- memory_entries.grounding (22-add-memory-grounding-column.sql), so later
-- phases can add values without a migration.
CREATE TABLE entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,     -- 'project' to start; reserved for later phases: 'user_fact' | 'preference' | 'learning' | 'decision' | 'document'
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT,
  source_table  TEXT,
  source_id     TEXT,
  source_path   TEXT,              -- relative path under KNOWLEDGE_STORE_PATH
  graphiti_id   TEXT,              -- episode uuid from graphiti-service, backfilled opportunistically - see consolidate.ts
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX entities_type_idx ON entities (type);
CREATE INDEX entities_source_idx ON entities (source_table, source_id);
