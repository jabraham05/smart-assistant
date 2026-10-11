-- Growth engine follow-up: the Review Queue could only show a proposal's
-- rationale, not the actual candidate text, because skill instructions /
-- persona edits were generated at consolidation time (after approval), not
-- stored ahead of it. These columns let a human see a real before/after
-- diff and evaluation result before deciding, and let approval reuse
-- exactly what was previewed instead of regenerating it.
ALTER TABLE growth_proposals
  ADD COLUMN IF NOT EXISTS current_text TEXT,
  ADD COLUMN IF NOT EXISTS proposed_text TEXT,
  ADD COLUMN IF NOT EXISTS preview_evaluation JSONB,
  ADD COLUMN IF NOT EXISTS previewed_at TIMESTAMPTZ;
