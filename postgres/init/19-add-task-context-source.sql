-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/19-add-task-context-source.sql
\connect events

-- Distinguishes a task_context Amy created autonomously from one the user
-- typed into the Home dashboard's todo list directly (see chat-ui's
-- /api/todos route). Purely a UI badge ("you added this" vs "Amy is
-- tracking this") - every other consumer (system-prompt's openTasksLine,
-- goal-matching, findOverlappingOpenTaskContext dedup) stays
-- origin-agnostic on purpose, so a user-added todo still surfaces to Amy
-- in conversation like any other open task.
ALTER TABLE task_contexts
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'amy'; -- amy | user
