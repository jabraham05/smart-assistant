-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). This volume already exists, so apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d growth < postgres/init/27-seed-golden-transcripts.sql
--
-- Ported verbatim from 96a56acd's own seed data - the acceptance test for
-- the whole attribution mechanism (see growth_judge.py's shared judge and
-- growth_consolidate.py's golden-transcript regression check, both of
-- which were no-ops with zero rows here). Reconstruction of the
-- 2026-07-28 persona/peer-card-drift incident: two independent causes
-- behind one symptom (stale persona_text AND an independently-drifting
-- Honcho peer card), the exact case a single-cause reviewer would miss.
\connect growth

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
)
ON CONFLICT (label) DO NOTHING;
