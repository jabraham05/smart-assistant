-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d skills < postgres/init/26-create-skill-metadata-table.sql
--
-- Growth engine Phase 7 (Skills v2). Additive to the existing skills
-- table (an n8n Data Table in the n8n database, read via db.py) - this
-- deliberately lives in a SEPARATE table/database rather than altering
-- that live Data Table's schema, so a skill with no metadata row behaves
-- exactly as it does today (always injected, full instructions). Keyed
-- by skill_name (a value match against skills.name, not a real FK - the
-- two tables live in different Postgres databases).
\connect skills

CREATE TABLE skill_metadata (
  skill_name          TEXT PRIMARY KEY,
  triggers            TEXT[] NOT NULL DEFAULT '{}',
  level2_summary      TEXT,
  level3_procedure    TEXT,
  level4_examples     TEXT,
  evaluation_criteria TEXT,
  dependencies        TEXT[] NOT NULL DEFAULT '{}',
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
