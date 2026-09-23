-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d research < postgres/init/18-add-project-activity-type.sql
\connect research

-- Generalizes projects (17-create-projects-table.sql) beyond "research
-- topic wrapper" to also cover coding work, via coding-orchestrator's
-- existing Planner/Coder/Tester/Reviewer pipeline. coding_task_id is
-- intentionally NOT a foreign key - coding_tasks lives in a separate
-- database (coding-orchestrator's own), so this is an opaque reference
-- resolved via that service's own GET /tasks/:id, not a join.
ALTER TABLE projects
  ADD COLUMN activity_type   TEXT NOT NULL DEFAULT 'research', -- research | coding
  ADD COLUMN coding_task_id  BIGINT,
  ADD COLUMN target_repo_url TEXT; -- coding only, optional: existing repo to target
