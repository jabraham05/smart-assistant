-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). If this volume already existed before this file was added (true for
-- this project), apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d postgres -c "CREATE DATABASE self_improvement OWNER assistant;"
--   docker compose exec -i postgres psql -U assistant -d self_improvement < postgres/init/08-create-self-improvement-db.sql
CREATE DATABASE self_improvement OWNER assistant;

\connect self_improvement

-- Owned by the Chat workflow + self_improvement_reviewer/self_improvement_proposer.
-- Personas change rarely; every review_turns/review_scores row references a
-- snapshot by hash instead of duplicating the full system_prompt on every
-- turn. Hash is computed in SQL (md5()), not in a Code node's JS - avoids
-- the documented Code-node-sandbox gotcha (require('crypto') / fetch()
-- being silently unavailable and masking a bug for weeks, see coding_skills
-- lessons and skill_gap_scanner's history).
CREATE TABLE persona_snapshots (
  hash          TEXT PRIMARY KEY,       -- md5(system_prompt)
  system_prompt TEXT NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-turn raw capture from the live Chat workflow's new "Log Turn" node.
-- This is the thing that didn't exist anywhere before this pipeline:
-- Honcho stores message text, but not tool-call traces, and never a
-- point-in-time snapshot of the peer cards as they were on that specific
-- turn (the live "Get User Card"/"Get User Card For Amy" nodes only ever
-- show the CURRENT card - useless for diagnosing a past incident like
-- 2026-07-28's drifting peer card after the fact).
CREATE TABLE review_turns (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id                  TEXT NOT NULL,
  occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_message                TEXT NOT NULL,
  agent_reply                 TEXT NOT NULL,
  tool_calls                  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{tool,input,output}]
  persona_prompt_hash         TEXT NOT NULL REFERENCES persona_snapshots(hash),
  user_card_snapshot          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Get User Card at that turn
  user_card_for_amy_snapshot  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Get User Card For Amy at that turn
  model                       TEXT NOT NULL DEFAULT 'qwen3:14b',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_turns_session_idx ON review_turns (session_id);
CREATE INDEX review_turns_occurred_at_idx ON review_turns (occurred_at DESC);

-- self_improvement_reviewer's incremental-scan cursor. One row, key='reviewer'.
-- Same "single sentinel row" shape as event-bus's scanner_state.
CREATE TABLE review_cursor (
  key               TEXT PRIMARY KEY,
  last_reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO review_cursor (key) VALUES ('reviewer');

-- One row per (session, context-length chunk) reviewed by the judge.
-- Scores are a decomposed rubric (five independent 1-5 dimensions), not a
-- single holistic score - decomposed criteria correlate with human
-- judgment far better than a single "was this good?" number.
CREATE TABLE review_scores (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id                TEXT NOT NULL,
  chunk_index                INTEGER NOT NULL DEFAULT 0,
  turn_ids                   JSONB NOT NULL,           -- [review_turns.id, ...] contiguous slice
  persona_prompt_hash        TEXT REFERENCES persona_snapshots(hash),
  model                      TEXT NOT NULL,
  task_success_score         INTEGER NOT NULL CHECK (task_success_score BETWEEN 1 AND 5),
  relevance_score            INTEGER NOT NULL CHECK (relevance_score BETWEEN 1 AND 5),
  persona_alignment_score    INTEGER NOT NULL CHECK (persona_alignment_score BETWEEN 1 AND 5),
  user_sentiment_score       INTEGER NOT NULL CHECK (user_sentiment_score BETWEEN 1 AND 5),
  followup_coherence_score   INTEGER NOT NULL CHECK (followup_coherence_score BETWEEN 1 AND 5),
  overall_notes               TEXT,
  raw_judge_output            JSONB NOT NULL,          -- full structured response, for audit
  flagged_for_human           BOOLEAN NOT NULL DEFAULT false,
  proposal_generated_at       TIMESTAMPTZ,              -- set once self_improvement_proposer consumes it
  reviewed_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_scores_session_idx ON review_scores (session_id);
CREATE INDEX review_scores_unconsumed_idx ON review_scores (proposal_generated_at) WHERE proposal_generated_at IS NULL;

-- One-to-MANY attribution per score row - the direct mechanism for the
-- 2026-07-28 incident requirement (one symptom, two independent causes:
-- stale persona_text AND an independently-drifting honcho_peer_card). A
-- single enum column on review_scores could never represent that; the
-- judge is explicitly instructed to list every distinct root cause it can
-- find, not stop at the first plausible one.
CREATE TABLE review_attributions (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_score_id    BIGINT NOT NULL REFERENCES review_scores(id) ON DELETE CASCADE,
  attribution_type   TEXT NOT NULL CHECK (attribution_type IN (
                        'persona_text', 'honcho_peer_card',
                        'model_capability_limitation', 'tool_failure',
                        'ambiguous_user_request', 'none')),
  confidence         NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence            TEXT NOT NULL,                -- must quote the transcript/trace
  suggested_fix_area  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_attributions_score_idx ON review_attributions (review_score_id);
CREATE INDEX review_attributions_type_idx ON review_attributions (attribution_type);

-- Curated regression set (a fix for one failure mode must not silently
-- regress another - self_improvement_proposer replays these against every
-- candidate persona edit before it's surfaced for human approval).
CREATE TABLE golden_transcripts (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label                  TEXT NOT NULL UNIQUE,        -- e.g. '2026-07-28-persona-card-drift'
  description            TEXT,
  transcript              TEXT NOT NULL,               -- formatted User:/Amy: text
  source_session_id       TEXT,
  expected_attribution    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- e.g. ["persona_text","honcho_peer_card"]
  expected_min_scores     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"persona_alignment_score":3}
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE golden_regression_runs (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  golden_transcript_id     BIGINT NOT NULL REFERENCES golden_transcripts(id) ON DELETE CASCADE,
  candidate_persona_hash   TEXT NOT NULL,
  baseline_scores           JSONB NOT NULL,
  candidate_scores           JSONB NOT NULL,
  regressed                  BOOLEAN NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX golden_regression_runs_candidate_idx ON golden_regression_runs (candidate_persona_hash);

-- Audit trail, same rationale as coding_task_log/events: one SELECT shows
-- exactly what happened, not a guess from scattered n8n execution logs.
CREATE TABLE review_runs (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  sessions_scanned    INTEGER,
  chunks_reviewed     INTEGER,
  status              TEXT NOT NULL DEFAULT 'running' -- running | complete | error
);

-- Seed: reconstruction of the 2026-07-28 incident (see project memory
-- amy_persona_tone_update.md) - the transcript the user reviewed that
-- triggered the persona rewrite. Root cause was two independent things at
-- once: the pre-rewrite system_prompt itself ("genuinely loyal... service
-- voice", no ban on reflexive help-offers) AND a Honcho peer card for Amy
-- that said Charter: "Assist the user with everything possible" / Role:
-- "Service provider". This is the acceptance test for the whole
-- attribution mechanism - the judge must return BOTH attribution rows for
-- this transcript, not one merged entry.
INSERT INTO golden_transcripts (label, description, transcript, expected_attribution, expected_min_scores) VALUES
(
  '2026-07-28-persona-card-drift',
  'Reconstructed from amy_persona_tone_update.md: reflexive help-offer stock phrases and costumed-butler-camp language surviving an in-conversation correction, caused simultaneously by pre-rewrite persona text and a stale Honcho peer card.',
  E'User: Can you check what''s on my calendar tomorrow?\n' ||
  E'Amy: Certainly, sir. Allow me to consult your calendar posthaste. You have a 10am dentist appointment and a 2pm call with the Morrison account. Is there anything else I might assist you with, or shall I fetch anything further for you?\n' ||
  E'User: Just the calendar was fine, you don''t need to add "anything else I can help with" every single time, it''s a lot.\n' ||
  E'Amy: Of course, sir - understood completely. Should you require any further assistance, know that I remain at your service.\n' ||
  E'User: ...that''s the same thing you just said you''d stop doing.\n' ||
  E'Amy: My apologies, sir. How else may I be of service to you today?',
  '["persona_text", "honcho_peer_card"]'::jsonb,
  '{"persona_alignment_score": 1, "followup_coherence_score": 2}'::jsonb
),
(
  '2026-07-28-post-fix-good-exchange',
  'Representative of the corrected persona behavior after both the system_prompt rewrite and the Honcho peer card PUT - regression canary to confirm a future persona edit does not reintroduce reflexive help-offers or butler-camp phrasing.',
  E'User: Can you check what''s on my calendar tomorrow?\n' ||
  E'Amy: 10am dentist, 2pm call with the Morrison account.\n' ||
  E'User: Thanks. Move the dentist to Thursday if there''s a slot.\n' ||
  E'Amy: Thursday works - moved it to 10am, nothing else on your calendar that day yet.',
  '["none"]'::jsonb,
  '{"persona_alignment_score": 4, "task_success_score": 4}'::jsonb
);
