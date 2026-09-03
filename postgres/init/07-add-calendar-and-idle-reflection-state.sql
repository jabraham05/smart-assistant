-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/07-add-calendar-and-idle-reflection-state.sql
\connect events

-- Owned by event-bus. Last-seen snapshot of upcoming Google Calendar events
-- (see calendar-watch.ts) - lets a poll tell "never seen this event before"
-- (-> google_calendar.event_detected) apart from "already reminded about
-- this one" (reminded_at set, so event_starting_soon only fires once).
CREATE TABLE calendar_watcher_state (
  event_id       TEXT PRIMARY KEY,
  summary        TEXT,
  start_time     TIMESTAMPTZ,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminded_at    TIMESTAMPTZ
);

-- New scanner_state keys, reusing the existing per-key cadence mechanism
-- (see 05-add-scanner-state.sql) rather than a new table:
--  - idle_reflection: gates how often the idle-time reflection's
--    Honcho+Ollama reasoning is allowed to run at all (only when work
--    level is low).
--  - idle_reflection_message: a separate, stricter cooldown specifically
--    for the "message the user directly" outcome, so a proactive DM can
--    fire at most once per cooldown window even if silent skill proposals
--    queue up more often in the meantime.
INSERT INTO scanner_state (key, last_run) VALUES
  ('idle_reflection', now()),
  ('idle_reflection_message', now());
