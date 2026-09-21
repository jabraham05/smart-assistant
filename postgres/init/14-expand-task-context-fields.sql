-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/14-expand-task-context-fields.sql
\connect events

-- The existing task_contexts (11-create-task-contexts-table.sql) only has
-- objective/capability/domain/status - genuinely lacks the working-memory
-- fields the architecture plan's TaskContext calls for. `objective` is
-- kept as the "goal" field rather than adding a duplicate column.
ALTER TABLE task_contexts
  ADD COLUMN IF NOT EXISTS facts       JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS unknowns    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS next_action TEXT;

-- Explicit steps for a task_context that needed planning (needsPlanning,
-- see classify-tools.ts) - a task can exist without any steps at all
-- (the simple "resume this later" case task_contexts already supported),
-- steps are additive for the genuinely multi-step case.
CREATE TABLE IF NOT EXISTS task_context_steps (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_context_id  BIGINT NOT NULL REFERENCES task_contexts(id) ON DELETE CASCADE,
  step_index       INTEGER NOT NULL,
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed | blocked | skipped
  failure_policy   TEXT,                             -- retry | recover | clarify | continue | skip | fail
  tool_result      JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_context_steps_task_context_idx ON task_context_steps (task_context_id);
