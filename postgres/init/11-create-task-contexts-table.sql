-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/11-create-task-contexts-table.sql
\connect events

-- Owned by event-bus, alongside goals/scanner_state - the cross-cutting,
-- not-owned-by-one-capability concept in this codebase. A task_context is
-- something that genuinely spans multiple real-world days and needs to
-- resume correctly later (e.g. "measure the fuel sender now, full reading
-- tomorrow"), unlike a goal (an ongoing objective with no expected
-- completion) or a research_session/coding_task (one bounded run).
-- Reconnection is by single-user identity (there is exactly one real human
-- user across every client - see docs/chat-workflow.md), not session id -
-- chat-ui mints a fresh random session id on every page load, so a
-- session-keyed lookup would silently fail on the realistic "resume
-- tomorrow in a new tab" case.
CREATE TABLE task_contexts (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  objective          TEXT NOT NULL,
  capability         TEXT,             -- metadata only, e.g. 'research'/'automotive' context
  domain             TEXT,             -- free-text, same convention as knowledge-engine's documents.domain
  status             TEXT NOT NULL DEFAULT 'active', -- active | waiting_for_user | done | abandoned
  origin_session_id  TEXT,             -- provenance/notify-back only, NOT the reconnection key
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_contexts_status_idx ON task_contexts (status);

-- Append-only accumulated notes, mirroring coding_task_log's structured-log
-- shape (closest existing template) but simplified - no attempt/phase
-- concept here, just notes the agent chooses to record as a task develops.
CREATE TABLE task_context_log (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_context_id  BIGINT NOT NULL REFERENCES task_contexts(id) ON DELETE CASCADE,
  note             TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_context_log_task_context_id_idx ON task_context_log (task_context_id);
