-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead (run once
-- per database, since \connect only takes effect for a single psql session when
-- the whole file is piped through -f in one go):
--   docker compose exec -i postgres psql -U assistant -d memory < postgres/init/31-add-user-id-columns.sql
--   docker compose exec -i postgres psql -U assistant -d growth < postgres/init/31-add-user-id-columns.sql

-- Part of the fix for test traffic polluting the real Honcho profile (see
-- config.py's is_test_user/TEST_USER_ID): identity is now an explicit
-- user_id passed by the caller instead of inferred from a session_id
-- prefix, and it's recorded alongside every write these tables already
-- took, so a given row's real/test identity is visible without having to
-- re-derive it from session_id. Nullable, no backfill - existing rows
-- predate this concept and shouldn't be guessed at; every row written by
-- the application going forward always carries a real value.
\connect memory

ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS memory_entries_user_id_idx ON memory_entries (user_id);

\connect growth

ALTER TABLE review_turns ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE growth_observations ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS review_turns_user_id_idx ON review_turns (user_id);
CREATE INDEX IF NOT EXISTS growth_observations_user_id_idx ON growth_observations (user_id);
CREATE INDEX IF NOT EXISTS teaching_sessions_user_id_idx ON teaching_sessions (user_id);
