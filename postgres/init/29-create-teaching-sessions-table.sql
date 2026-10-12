-- Growth engine Phase 10 (Teaching layer, docs/unified-architecture-gap-
-- analysis.md §7). One shared lifecycle for all three teaching modes
-- (demonstration / guided_practice / explain_and_build) - a teaching
-- session is a new *source* feeding the existing Growth classification and
-- consolidation pipeline (growth_proposals/learning_plans/experiments/
-- evaluations), not a parallel one. Lives in the same `growth` database as
-- the rest of the Growth engine.
CREATE TABLE IF NOT EXISTS teaching_sessions (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id              TEXT,       -- conversation this teaching happened in
  mode                    TEXT NOT NULL CHECK (mode IN ('demonstration', 'guided_practice', 'explain_and_build')),
  status                  TEXT NOT NULL DEFAULT 'capturing', -- capturing | classified | routed | consolidated | abandoned
  captured_content        TEXT NOT NULL DEFAULT '',          -- accumulated instructions/corrections, append-only
  category                TEXT,       -- knowledge | skill | behavior | tool - set by classify_teaching_content
  classification_reasoning TEXT,
  extracted_procedure     TEXT,
  extracted_rules         TEXT,
  extracted_examples      TEXT,
  open_questions          TEXT,
  opportunity_id          BIGINT REFERENCES growth_opportunities(id),
  proposal_id             BIGINT REFERENCES growth_proposals(id),
  entity_id               TEXT,       -- set when routed to knowledge; entities lives in a different DB, same loose-reference convention growth_history.entity_id already uses
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_teaching_sessions_status ON teaching_sessions(status);
CREATE INDEX IF NOT EXISTS idx_teaching_sessions_session_id ON teaching_sessions(session_id);
