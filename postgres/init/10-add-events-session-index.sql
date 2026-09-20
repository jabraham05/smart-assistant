-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/10-add-events-session-index.sql
\connect events

-- Supports GET /sessions/:sessionId/last-capability's "most recent
-- classification event for this session" lookup (see index.ts) - the Chat
-- workflow now publishes a message_received event carrying
-- payload.relevantGroups on every turn, and this index makes finding the
-- latest one per session cheap as that table grows. events.origin_session_id
-- already exists (04-create-events-db.sql); this only adds the index.
CREATE INDEX events_origin_session_idx ON events (origin_session_id, occurred_at DESC);
