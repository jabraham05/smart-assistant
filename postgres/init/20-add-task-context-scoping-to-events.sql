-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/20-add-task-context-scoping-to-events.sql
\connect events

-- Lets the new per-task activity feed (GET /task-contexts/:id/activity)
-- filter events with plain SQL instead of JSONB matching. Same database as
-- task_contexts (both owned by event-bus), so a real FK is possible here -
-- unlike coding_task_id/research_session_id elsewhere, which are opaque
-- cross-database references.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS task_context_id BIGINT REFERENCES task_contexts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS events_task_context_id_idx ON events (task_context_id);
