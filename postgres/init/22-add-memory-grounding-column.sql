\connect memory

-- Deterministic, no-LLM provenance tag computed by the caller
-- (agent-service's safety_net.classify_memory_grounding / chat-orchestrator's
-- TS port) at ingest time - memory-engine stays a thin, policy-agnostic
-- store, same as it already is for domain/task_context_id. Values:
--   'user_stated'    - role='user' content. Not Amy's generated claim at
--                       all, so never penalized regardless of tool activity.
--   'tool_verified'   - role='assistant' content from a turn where at least
--                       one tool was actually called (an exact, cheap,
--                       known-coarse signal - matches the existing
--                       is_confabulated_action/has_fabricated_id_reference
--                       turn-level granularity, not sentence-level).
--   'ungrounded'      - role='assistant' content from a turn with ZERO tool
--                       calls - pure generated/recalled prose. This is
--                       exactly the shape of the "Qwen3.8-LiveTranslate
--                       API"/WebRTC incident this column exists to flag.
-- No CHECK constraint, matching findings.confidence's existing free-text
-- convention - keeps future value additions migration-free. Pre-existing
-- rows predate this column and get the conservative default ('ungrounded')
-- rather than any retroactive attempt to reconstruct what tools (if any)
-- ran when they were originally written.
ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS grounding TEXT NOT NULL DEFAULT 'ungrounded';

CREATE INDEX IF NOT EXISTS memory_entries_grounding_idx ON memory_entries (grounding);
