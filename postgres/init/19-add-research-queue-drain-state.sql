-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/19-add-research-queue-drain-state.sql
\connect events

-- New scanner_state key for the research queue's periodic drain fallback
-- (see event-bus's POST /calendar/poll-check) - real bug found via live
-- testing: draining only ever happened on a calendar wake event, and with
-- none ever created, real topics sat at 'pending' indefinitely. Seeded
-- far in the past (same convention as 12-add-overnight-digest-state.sql)
-- so the very first poll-check after this deploys drains immediately
-- rather than waiting a full researchQueueDrainMinHours first.
INSERT INTO scanner_state (key, last_run) VALUES
  ('research_queue_drain', now() - interval '1 day')
ON CONFLICT (key) DO NOTHING;
