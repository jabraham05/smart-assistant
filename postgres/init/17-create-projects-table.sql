-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d research < postgres/init/17-create-projects-table.sql
\connect research

-- A project is a human-approved, bounded unit of autonomous research Amy
-- proposes and then actually goes and does - see docs/knowledge-engine.md's
-- dated entry. Lives here (not event-bus's `events` DB, where task_contexts/
-- goals live) because every field it needs to reference - research_queue,
-- research_sessions, documents - already lives in this database, so it gets
-- real foreign keys and the approve step can enqueue in-process with no
-- cross-service HTTP hop.
CREATE TABLE projects (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title                TEXT NOT NULL,
  rationale            TEXT NOT NULL,
  domain               TEXT,
  status               TEXT NOT NULL DEFAULT 'proposed', -- proposed | active | done | rejected
  origin               TEXT NOT NULL DEFAULT 'amy_proposed', -- amy_proposed | user_requested
  research_queue_id    BIGINT REFERENCES research_queue(id),
  research_session_id  BIGINT REFERENCES research_sessions(id),
  document_id          BIGINT REFERENCES documents(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at          TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_status_idx ON projects (status);
