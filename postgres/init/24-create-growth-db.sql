-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d postgres -c "CREATE DATABASE growth OWNER assistant;"
--   docker compose exec -i postgres psql -U assistant -d growth < postgres/init/24-create-growth-db.sql
--
-- Phase 6.1 of the unified-architecture roadmap (docs/unified-architecture-
-- gap-analysis.md, docs/growth-engine.md): the Growth engine's own database,
-- same one-database-per-concern convention as events/research/memory/skills.
-- Growth lives inside agent-service rather than as its own microservice -
-- "move the lifecycle into agent-service and the current architecture, do
-- not resurrect the old n8n implementation" - but still gets its own
-- database rather than bolting onto n8n's or research's.
--
-- Table group 1 (persona_snapshots through review_runs) is ported from the
-- abandoned self-improvement pipeline (commit 96a56acd, branch
-- origin/worktree-self-improvement-cycle, never merged - see the gap
-- analysis doc). The schema/rubric design was validated there; only the
-- n8n implementation was stale. Table group 2 (growth_opportunities
-- onward) is new: the general Observations -> Opportunities -> Proposals ->
-- Learning Plans -> Experiments -> Evaluations -> History lifecycle the
-- vision describes, which 96a56acd never had (it only ever reviewed
-- persona behavior, not skills/knowledge/tool gaps generally).
CREATE DATABASE growth OWNER assistant;

\connect growth

-- ============================================================
-- Group 1: ported from 96a56acd (persona/conversation review)
-- ============================================================

-- Personas change rarely; every review_turns/review_scores row references
-- a snapshot by hash instead of duplicating the full system_prompt on every
-- turn.
CREATE TABLE persona_snapshots (
  hash          TEXT PRIMARY KEY,       -- md5(system_prompt)
  system_prompt TEXT NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-turn raw capture, written as a side effect of agent-service's
-- existing post-turn persistence step (next to the Honcho/memory-engine
-- writes) - see main.py. Honcho stores message text, but never a
-- point-in-time snapshot of the peer cards as they were on that specific
-- turn (the live Honcho card endpoints only ever show the CURRENT card -
-- useless for diagnosing a past incident after the fact).
CREATE TABLE review_turns (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id                  TEXT NOT NULL,
  occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_message                TEXT NOT NULL,
  agent_reply                 TEXT NOT NULL,
  tool_calls                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  persona_prompt_hash         TEXT NOT NULL REFERENCES persona_snapshots(hash),
  user_card_snapshot          JSONB NOT NULL DEFAULT '[]'::jsonb,
  user_card_for_amy_snapshot  JSONB NOT NULL DEFAULT '[]'::jsonb,
  model                       TEXT NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_turns_session_idx ON review_turns (session_id);
CREATE INDEX review_turns_occurred_at_idx ON review_turns (occurred_at DESC);

-- A future reviewer's incremental-scan cursor. One row, key='reviewer'.
-- Same "single sentinel row" shape as event-bus's scanner_state.
CREATE TABLE review_cursor (
  key               TEXT PRIMARY KEY,
  last_reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO review_cursor (key) VALUES ('reviewer');

-- One row per (session, context-length chunk) reviewed by a judge. Scores
-- are a decomposed rubric (five independent 1-5 dimensions), not a single
-- holistic score - decomposed criteria correlate with human judgment far
-- better than one "was this good?" number. Phase 6.1 only creates this
-- table; Phase 6.4 (Experiments + Evaluation) wires the judge that writes
-- to it.
CREATE TABLE review_scores (
  id                         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id                 TEXT NOT NULL,
  chunk_index                INTEGER NOT NULL DEFAULT 0,
  turn_ids                   JSONB NOT NULL,           -- [review_turns.id, ...] contiguous slice
  persona_prompt_hash        TEXT REFERENCES persona_snapshots(hash),
  model                      TEXT NOT NULL,
  task_success_score         INTEGER NOT NULL CHECK (task_success_score BETWEEN 1 AND 5),
  relevance_score            INTEGER NOT NULL CHECK (relevance_score BETWEEN 1 AND 5),
  persona_alignment_score    INTEGER NOT NULL CHECK (persona_alignment_score BETWEEN 1 AND 5),
  user_sentiment_score       INTEGER NOT NULL CHECK (user_sentiment_score BETWEEN 1 AND 5),
  followup_coherence_score   INTEGER NOT NULL CHECK (followup_coherence_score BETWEEN 1 AND 5),
  overall_notes              TEXT,
  raw_judge_output           JSONB NOT NULL,          -- full structured response, for audit
  flagged_for_human          BOOLEAN NOT NULL DEFAULT false,
  proposal_generated_at      TIMESTAMPTZ,              -- set once an opportunity/proposal consumes it
  reviewed_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_scores_session_idx ON review_scores (session_id);
CREATE INDEX review_scores_unconsumed_idx ON review_scores (proposal_generated_at) WHERE proposal_generated_at IS NULL;

-- One-to-MANY attribution per score row - a single symptom can have more
-- than one independent cause (the 2026-07-28 persona/peer-card-drift
-- incident had two at once: stale persona_text AND an independently-
-- drifting honcho_peer_card). A single enum column on review_scores could
-- never represent that.
CREATE TABLE review_attributions (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_score_id    BIGINT NOT NULL REFERENCES review_scores(id) ON DELETE CASCADE,
  attribution_type   TEXT NOT NULL CHECK (attribution_type IN (
                        'persona_text', 'honcho_peer_card',
                        'model_capability_limitation', 'tool_failure',
                        'ambiguous_user_request', 'none')),
  confidence         NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence           TEXT NOT NULL,                -- must quote the transcript/trace
  suggested_fix_area TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_attributions_score_idx ON review_attributions (review_score_id);
CREATE INDEX review_attributions_type_idx ON review_attributions (attribution_type);

-- Curated regression set - a fix for one failure mode must not silently
-- regress another. Any candidate persona edit gets replayed against these
-- before being surfaced for human approval (Phase 6.4/6.5).
CREATE TABLE golden_transcripts (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label                 TEXT NOT NULL UNIQUE,
  description           TEXT,
  transcript            TEXT NOT NULL,
  source_session_id     TEXT,
  expected_attribution   JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_min_scores    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE golden_regression_runs (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  golden_transcript_id     BIGINT NOT NULL REFERENCES golden_transcripts(id) ON DELETE CASCADE,
  candidate_persona_hash   TEXT NOT NULL,
  baseline_scores          JSONB NOT NULL,
  candidate_scores         JSONB NOT NULL,
  regressed                BOOLEAN NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX golden_regression_runs_candidate_idx ON golden_regression_runs (candidate_persona_hash);

-- Audit trail, same rationale as coding_task_log/events: one SELECT shows
-- exactly what happened, not a guess from scattered logs.
CREATE TABLE review_runs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  sessions_scanned INTEGER,
  chunks_reviewed  INTEGER,
  status           TEXT NOT NULL DEFAULT 'running' -- running | complete | error
);

-- ============================================================
-- Group 2: new - the general Growth lifecycle (Phase 6.1-6.5)
-- ============================================================

-- One row per accumulated, scored candidate for improvement. Signals
-- (behaviorFeedback, knowledgeGapTopic, idle_reflection, skill_gap_scanner,
-- tool failures, safety-net failures, user corrections, review_scores)
-- accumulate as growth_observations against an opportunity before it's
-- ever turned into a proposal - "signal -> proposal" directly would make
-- Amy noisy; scoring first (Phase 6.2) is what makes her selective. No
-- CHECK on category - same free-text convention as entities.type and
-- findings.confidence, so later phases can add values (e.g. a 'tool'
-- branch) without a migration.
CREATE TABLE growth_opportunities (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL,
  category           TEXT,       -- knowledge | skill | behavior | tool - set by Phase 6.3 classification
  frequency          INTEGER NOT NULL DEFAULT 1,
  usefulness         NUMERIC(4,2),
  confidence         NUMERIC(4,2),
  reuse_potential    NUMERIC(4,2),
  improvement_value  NUMERIC(4,2),
  effort             NUMERIC(4,2),
  interruption_cost  NUMERIC(4,2),
  -- frequency + usefulness + confidence + reuse_potential + improvement_value
  --   - effort - interruption_cost, per the roadmap's scoring model. Computed
  -- and written by Phase 6.2's scoring logic, not by a generated column,
  -- since the exact weighting is expected to be tuned over time.
  score              NUMERIC(8,2),
  status             TEXT NOT NULL DEFAULT 'observed', -- observed | scored | proposed | rejected | dormant
  first_observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX growth_opportunities_status_idx ON growth_opportunities (status);
CREATE INDEX growth_opportunities_category_idx ON growth_opportunities (category);

-- Raw signal captures. source identifies which existing mechanism produced
-- it (today's behaviorFeedback/knowledgeGapTopic/idle_reflection/
-- skill_gap_scanner, plus new ones this phase adds: tool_failure,
-- safety_net_failure, user_correction, review_score) so later phases can
-- audit which signal types actually drive useful opportunities. Nullable
-- opportunity_id: an observation starts unlinked and gets attached once
-- accumulation (Phase 6.2) groups it with others into an opportunity.
CREATE TABLE growth_observations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source          TEXT NOT NULL,
  category        TEXT,
  summary         TEXT NOT NULL,
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  session_id      TEXT,
  opportunity_id  BIGINT REFERENCES growth_opportunities(id),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX growth_observations_opportunity_idx ON growth_observations (opportunity_id);
CREATE INDEX growth_observations_source_idx ON growth_observations (source);
CREATE INDEX growth_observations_unlinked_idx ON growth_observations (opportunity_id) WHERE opportunity_id IS NULL;

-- A proposal generated from an opportunity once it clears the scoring
-- threshold (Phase 6.2) and is classified (Phase 6.3). approval_tier
-- records which of the three autonomy tiers (docs/unified-architecture-
-- gap-analysis.md §8) this proposal falls under - almost everything here
-- is tier2 (user approval) by default; nothing in this schema can promote
-- itself to tier1 on its own.
CREATE TABLE growth_proposals (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id   BIGINT NOT NULL REFERENCES growth_opportunities(id),
  category         TEXT NOT NULL, -- knowledge | skill | behavior | tool
  proposed_action  TEXT NOT NULL,
  rationale        TEXT NOT NULL,
  approval_tier    TEXT NOT NULL DEFAULT 'tier2', -- tier1 | tier2 | tier3
  status           TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | rejected | superseded
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at      TIMESTAMPTZ,
  reviewer_notes   TEXT
);
CREATE INDEX growth_proposals_opportunity_idx ON growth_proposals (opportunity_id);
CREATE INDEX growth_proposals_status_idx ON growth_proposals (status);

-- Ordered steps toward acting on an approved (or self-approved tier1)
-- proposal. steps is a JSONB array of {description, status} objects rather
-- than a child table - plans are edited as a whole by whichever process
-- (human or Amy) is driving them, not queried step-by-step.
CREATE TABLE learning_plans (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id BIGINT NOT NULL REFERENCES growth_proposals(id),
  goal        TEXT NOT NULL,
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'draft', -- draft | active | complete | abandoned
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX learning_plans_proposal_idx ON learning_plans (proposal_id);

-- A baseline-vs-candidate run, e.g. "10 historical job-evaluation examples,
-- old approach vs. new Job Evaluation skill." Definitions are JSONB rather
-- than a fixed schema because what gets compared varies enormously by
-- category (a fixture-file reference for a skill change, a golden-
-- transcript set for a persona change, a before/after eval-harness score
-- for a classifier change).
CREATE TABLE experiments (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  learning_plan_id     BIGINT REFERENCES learning_plans(id),
  proposal_id          BIGINT REFERENCES growth_proposals(id),
  description          TEXT NOT NULL,
  baseline_definition  JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  status               TEXT NOT NULL DEFAULT 'pending', -- pending | running | complete | failed
  started_at           TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX experiments_proposal_idx ON experiments (proposal_id);

-- The comparison result for one experiment. improved is a nullable
-- boolean rather than inferred from scores alone, since "improved" can
-- depend on more than a single metric (e.g. a regression-check failure
-- overrides a higher raw score, mirroring golden_regression_runs.regressed).
CREATE TABLE evaluations (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  experiment_id     BIGINT NOT NULL REFERENCES experiments(id),
  metric            TEXT NOT NULL,
  baseline_score    NUMERIC(8,3),
  candidate_score   NUMERIC(8,3),
  improved          BOOLEAN,
  baseline_results  JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_results JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes             TEXT,
  evaluated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evaluations_experiment_idx ON evaluations (experiment_id);

-- Append-only ledger of what happened to an opportunity/proposal over
-- time - "Amy's development history." entity_id is a loose cross-database
-- reference (research.entities.id) rather than an FK, since entities lives
-- in a different Postgres database; Phase 6.5 (Consolidation) is expected
-- to be the only writer that ever sets it, once an improvement actually
-- lands in knowledge/skills/user-model/graph.
CREATE TABLE growth_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id  BIGINT REFERENCES growth_opportunities(id),
  proposal_id     BIGINT REFERENCES growth_proposals(id),
  event_type      TEXT NOT NULL, -- observed | scored | proposed | experiment_run | evaluated | approved | rejected | consolidated
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  entity_id       UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX growth_history_opportunity_idx ON growth_history (opportunity_id);
CREATE INDEX growth_history_event_type_idx ON growth_history (event_type);
