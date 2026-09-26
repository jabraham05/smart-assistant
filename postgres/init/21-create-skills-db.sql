-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d postgres -c "CREATE DATABASE skills OWNER assistant;"
--   docker compose exec -i postgres psql -U assistant -d skills < postgres/init/21-create-skills-db.sql
CREATE DATABASE skills OWNER assistant;

\connect skills

-- Replaces the old skill_proposal_intake n8n workflow + n8n's own internal
-- `skills` Data Table, which had no REST read/approve path at all - a human
-- could only review proposals by opening n8n's UI directly. skills-mcp's
-- own dedicated database, same tier as coding_tasks/research/events - this
-- is the first Postgres connection skills-mcp has ever owned.
CREATE TABLE skill_proposals (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind               TEXT NOT NULL,               -- instruction | tool_idea
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  reason             TEXT NOT NULL,
  instructions       TEXT,                        -- set when kind='instruction'
  tool_idea_details  TEXT,                         -- set when kind='tool_idea'
  status             TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | rejected
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at        TIMESTAMPTZ
);
CREATE INDEX skill_proposals_status_idx ON skill_proposals (status);
