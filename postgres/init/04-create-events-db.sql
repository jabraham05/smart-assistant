-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). If this volume already existed before this file was added, apply it
-- manually instead:
--   docker compose exec -i postgres psql -U assistant -d postgres -c "CREATE DATABASE events OWNER assistant;"
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/04-create-events-db.sql
CREATE DATABASE events OWNER assistant;

\connect events

-- Owned by event-bus. Every event is recorded here even when classify.ts
-- decides not to notify on it - goal-matching still runs against it, and
-- it's a real audit trail (same rationale as coding_task_log: one SELECT
-- shows exactly what happened, not a guess from scattered logs).
CREATE TABLE events (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source             TEXT NOT NULL,               -- 'coding_orchestrator' | 'discord' | 'pi_dashboard' | ...
  type               TEXT NOT NULL,                -- 'task_completed' | 'dm_received' | 'control_changed' | ...
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin_session_id  TEXT,
  priority           TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high, set by classify.ts
  should_notify      BOOLEAN NOT NULL DEFAULT false,
  -- new | processed | notified | notify_skipped_no_session
  status             TEXT NOT NULL DEFAULT 'new',
  notified_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_source_type_idx ON events (source, type);
CREATE INDEX events_occurred_at_idx ON events (occurred_at DESC);

-- Persistent user objectives. keywords are set at creation time (either
-- given explicitly or derived deterministically by event-bus's /goals
-- handler) and are the entire matching mechanism in v1 - no embeddings, no
-- LLM. See goal-matching.ts.
CREATE TABLE goals (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title              TEXT NOT NULL,
  description        TEXT,
  keywords           JSONB NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT NOT NULL DEFAULT 'active',  -- active | done | abandoned
  origin_session_id  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only record of every event that matched an active goal's
-- keywords, plus the stale-goal nudge doesn't write here (it's a question,
-- not progress) - only real keyword matches land in this table, so
-- goal_manage's action='progress' reflects genuine matched activity.
CREATE TABLE goal_progress_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  goal_id     BIGINT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  event_id    BIGINT REFERENCES events(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX goal_progress_log_goal_id_idx ON goal_progress_log (goal_id);
