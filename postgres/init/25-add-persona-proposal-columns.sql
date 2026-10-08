-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d n8n < postgres/init/25-add-persona-proposal-columns.sql
--
-- Growth engine Phase 6.5 (consolidation). The abandoned self-improvement
-- pipeline (96a56acd) described these as "the existing dormant
-- personas.proposed_system_prompt/proposed_reason columns" - but a direct
-- check of this branch's live n8n database found they don't actually
-- exist here (that branch's own persona-change work was itself never
-- merged). Adding them now, for real, as part of actually building
-- consolidation rather than assuming prior art that turned out not to be
-- there.
--
-- n8n's Data Table feature stores "personas" as a VIEW (public.personas)
-- over an internal table with a generated name - altering the real table
-- directly, then recreating the view to expose the new columns, same
-- pattern as any other direct-SQL access to n8n Data Tables in this
-- project (db.py already bypasses n8n's own API to read this table).
\connect n8n

ALTER TABLE "data_table_user_9E02ctNxKP8AGEqI" ADD COLUMN IF NOT EXISTS proposed_system_prompt TEXT;
ALTER TABLE "data_table_user_9E02ctNxKP8AGEqI" ADD COLUMN IF NOT EXISTS proposed_reason TEXT;
ALTER TABLE "data_table_user_9E02ctNxKP8AGEqI" ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ;

CREATE OR REPLACE VIEW public.personas AS
  SELECT id, "createdAt", "updatedAt", name, system_prompt,
         proposed_system_prompt, proposed_reason, proposed_at
  FROM "data_table_user_9E02ctNxKP8AGEqI";
