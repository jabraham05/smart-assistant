-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/12-add-overnight-digest-state.sql
\connect events

-- New scanner_state keys for the overnight digest (see event-bus's
-- /overnight-digest-check), mirroring idle_reflection's two-key pattern
-- (07-add-calendar-and-idle-reflection-state.sql):
--  - overnight_digest: last time the digest scanner actually ran and
--    checked for awaiting_digest events - not the cooldown that matters
--    for user-visible behavior, just bookkeeping.
--  - overnight_digest_message: the real cooldown - at most one proactive
--    digest DM per window, regardless of how many awaiting_digest events
--    piled up or how many times the calendar's wake event gets detected.
INSERT INTO scanner_state (key, last_run) VALUES
  ('overnight_digest', now() - interval '1 day'),
  ('overnight_digest_message', now() - interval '1 day')
ON CONFLICT (key) DO NOTHING;
