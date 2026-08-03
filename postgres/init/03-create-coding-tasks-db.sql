-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). If this volume already existed before this file was added, apply it
-- manually instead:
--   docker compose exec -i postgres psql -U assistant -d postgres -c "CREATE DATABASE coding_tasks OWNER assistant;"
--   docker compose exec -i postgres psql -U assistant -d coding_tasks < postgres/init/03-create-coding-tasks-db.sql
CREATE DATABASE coding_tasks OWNER assistant;

\connect coding_tasks

-- Replaces the old n8n Data Table `codingproposals1`. Owned by
-- coding-orchestrator now, not n8n - the old Data Table's rows are left
-- alone as historical debug records, not migrated.
CREATE TABLE coding_tasks (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_description   TEXT NOT NULL,
  target_repo_url    TEXT,
  target_ref         TEXT NOT NULL DEFAULT 'main',
  test_command       TEXT, -- explicit caller override only; the Planner infers one otherwise
  fallback_repo_url  TEXT,
  project_folder     TEXT,
  origin_session_id  TEXT,
  -- running | proposed | needs_review_failed | resource_limit_reached
  status             TEXT NOT NULL DEFAULT 'running',
  latest_status      TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 1,
  container_id       TEXT,
  diff               TEXT,
  test_output        TEXT,
  reviewer_verdict   TEXT,
  reviewer_reason    TEXT,
  pr_url             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX coding_tasks_origin_session_idx ON coding_tasks (origin_session_id);

-- Replaces the old n8n Data Table `codingtasklog01`, plus (unlike it) a
-- real structured record of failures - phase + status + error_message on
-- every row, not just a happy-path transcript. This is the direct fix for
-- weak point #8: every bug found during today's rethink required manually
-- decoding n8n's raw flatted execution_data; this table is meant to make
-- that unnecessary going forward - one SELECT shows exactly which phase of
-- which attempt failed and why.
CREATE TABLE coding_task_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id         BIGINT NOT NULL REFERENCES coding_tasks(id) ON DELETE CASCADE,
  attempt_number  INTEGER,
  -- plan | coder | tester | diff | test_run | reviewer | error
  phase           TEXT NOT NULL,
  status          TEXT NOT NULL, -- success | error
  error_message   TEXT,
  content         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX coding_task_log_task_id_idx ON coding_task_log (task_id);
