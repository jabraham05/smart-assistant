-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). If this volume already existed before this file was added (true for
-- this project as of 2026-08), apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d events < postgres/init/05-add-scanner-state.sql
\connect events

-- Owned by event-bus. Tracks when a periodic scanner (currently just
-- skill_gap_scanner) last actually ran, so /skill-gap-check can gate on
-- "N messages since last_run" instead of skill_gap_scanner polling on a
-- fixed wall-clock schedule regardless of whether anything happened.
CREATE TABLE scanner_state (
  key       TEXT PRIMARY KEY,
  last_run  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO scanner_state (key, last_run) VALUES ('skill_gap_scanner', now());
