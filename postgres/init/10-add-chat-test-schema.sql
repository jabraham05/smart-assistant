-- Originally for chat-orchestrator's persona/skills reads against a
-- schema-configurable view, so the exact same query shape works against
-- real production data ('public') or a safe test copy ('chat_test') just
-- by switching the CHAT_DB_SCHEMA env var - no per-request flag, no code
-- branching on environment. agent-service's own db.py reuses the same
-- CHAT_DB_SCHEMA convention and public.personas/public.skills views below,
-- but was never given a -test instance, so the chat_test schema itself is
-- now orphaned: chat-orchestrator-test (its only consumer) was retired
-- and deleted 2026-10-13 - see docs/chat-orchestrator.md. Left in place
-- (not dropped) since this is a manual-apply migration against real,
-- already-applied data, not something to unilaterally undo.
--
-- Runs against the `n8n` database (personas/skills are n8n Data Tables -
-- see docs/known-gotchas.md's Data Table DDL note for how these physical
-- tables are named/shaped). Manual-apply only, same caveat every prior
-- schema addition in this project has had - postgres/init/ only runs
-- automatically against an empty volume, and this one already has data:
--
--   docker compose exec -T postgres psql -U assistant -d n8n < postgres/init/10-add-chat-test-schema.sql

-- Plain read-only views aliasing n8n's real Data Table physical tables
-- (data_table_user_<id> - confirmed via \d against the live database, IDs
-- are stable per-table n8n internals, not something this file invents).
-- Nothing ever writes through these views - approving a skill or editing
-- a persona still happens exactly where it does today, in n8n's Data
-- Table UI.
CREATE OR REPLACE VIEW public.personas AS
  SELECT id, "createdAt", "updatedAt", name, system_prompt
  FROM public."data_table_user_9E02ctNxKP8AGEqI";

CREATE OR REPLACE VIEW public.skills AS
  SELECT id, "createdAt", "updatedAt", name, description, kind, instructions, tool_idea_details, reason, status
  FROM public."data_table_user_suWDTLC9t3H1ESud";

-- A real, plain Postgres schema (not an n8n Data Table - no UI, no
-- draft/publish layer, just SQL) a human can freely edit to try a
-- persona/skill change safely against chat-orchestrator-test before
-- promoting it into the real n8n Data Table via the UI. Seeded once from
-- current production rows; re-running this file is safe (CREATE TABLE IF
-- NOT EXISTS, seed only fires when the table is empty).
CREATE SCHEMA IF NOT EXISTS chat_test;

CREATE TABLE IF NOT EXISTS chat_test.personas (
  id SERIAL PRIMARY KEY,
  name TEXT,
  system_prompt TEXT
);

CREATE TABLE IF NOT EXISTS chat_test.skills (
  id SERIAL PRIMARY KEY,
  name TEXT,
  description TEXT,
  kind TEXT,
  instructions TEXT,
  tool_idea_details TEXT,
  reason TEXT,
  status TEXT
);

INSERT INTO chat_test.personas (name, system_prompt)
  SELECT name, system_prompt FROM public.personas
  WHERE NOT EXISTS (SELECT 1 FROM chat_test.personas);

INSERT INTO chat_test.skills (name, description, kind, instructions, tool_idea_details, reason, status)
  SELECT name, description, kind, instructions, tool_idea_details, reason, status FROM public.skills
  WHERE NOT EXISTS (SELECT 1 FROM chat_test.skills);
