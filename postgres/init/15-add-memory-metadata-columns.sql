-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d memory < postgres/init/15-add-memory-metadata-columns.sql
\connect memory

-- Phase 3b: metadata filtering for memory-engine's retrieval, per the
-- architecture plan's original cross-session-retrieval design.
-- - domain: the Coordinator's classified capability groups at ingest
--   time (comma-joined, e.g. "scheduling,info"), not knowledge-engine's
--   free-text world-fact domains ("automotive"/"warframe") - a different
--   vocabulary for a different kind of "what is this about."
-- - task_context_id: which open task_context (if any) was active when
--   this turn happened - lets a recall be scoped to one task's own
--   timeline instead of the whole global history. No foreign key
--   constraint (task_contexts lives in a different database - events),
--   same cross-database-reference convention already used elsewhere in
--   this project (e.g. origin_session_id fields generally).
ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS domain TEXT,
  ADD COLUMN IF NOT EXISTS task_context_id BIGINT;

CREATE INDEX IF NOT EXISTS memory_entries_domain_idx ON memory_entries (domain);
CREATE INDEX IF NOT EXISTS memory_entries_task_context_id_idx ON memory_entries (task_context_id);
