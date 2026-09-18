-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d research < postgres/init/09-add-domain-skills-table.sql
\connect research

-- Owned by knowledge-engine (see engine/domain-skills.ts). Domain-specific
-- policy - source authority, freshness requirements, which metadata field
-- represents "version" for that domain - as database-backed config,
-- editable via direct SQL the same way the personas/skills Data Tables are
-- hand-edited today. A domain with no row here gets the deterministic
-- default policy (no freshness boost, no authority tiering) - this table
-- is additive config, not a required registration step.
CREATE TABLE domain_skills (
  domain              TEXT PRIMARY KEY,
  source_priority     JSONB NOT NULL DEFAULT '[]'::jsonb, -- ordered authority_tier values, most trusted first
  freshness_required  BOOLEAN NOT NULL DEFAULT false,
  version_field       TEXT,     -- metadata key representing "version" for this domain, e.g. 'game_patch'
  notes               TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
