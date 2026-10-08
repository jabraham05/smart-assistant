"""Growth engine Phase 9: the autonomous Growth loop. Ties Phase 6.2
(opportunity scoring) and 6.4 (the shared judge) into the actual
"Amy interacts -> experiences -> observations -> Growth evaluates ->
should I improve?" cycle the roadmap diagrams - without this, review_scores/
review_attributions would never get populated by anything, and the
knowledge_gap/behavior_feedback/safety_net_failure observations already
wired into main.py would be the only signals Growth ever sees.

Runs as a background asyncio task inside agent-service (started at
startup in main.py) rather than a new n8n workflow - same "Growth lives in
agent-service and the current architecture" choice as the rest of this
phase. Cadence matches idle_reflection's existing 30-minute interval,
since this is the same tier of ambient background work.

Tier 1 only (per the autonomy model, docs/unified-architecture-gap-
analysis.md §8): judging conversations, recording observations, scoring/
promoting opportunities into proposals are all autonomous. Nothing in this
loop ever approves or consolidates a proposal - that still requires an
explicit human decision via growth_review (Tier 2)."""

from __future__ import annotations

import asyncio
import logging

from . import growth_db, growth_judge
from .config import Config

logger = logging.getLogger(__name__)

# Only attribution types Growth can plausibly act on become observations -
# 'model_capability_limitation' and 'none' aren't addressable by a
# knowledge/skill/behavior/tool change, so recording them would just add
# noise to the opportunity backlog.
_ACTIONABLE_ATTRIBUTION_CATEGORY = {
    "tool_failure": "tool",
    "persona_text": "behavior",
    "honcho_peer_card": "behavior",
    "ambiguous_user_request": "behavior",
}

_MIN_ATTRIBUTION_CONFIDENCE = 0.5
_DEFAULT_INTERVAL_SECONDS = 1800  # 30 minutes, same cadence as idle_reflection


async def run_sweep(config: Config, batch_size: int = 20) -> dict:
    """One pass: judge a batch of not-yet-reviewed review_turns, persist
    the scores/attributions, and feed actionable attributions into
    growth_db.record_observation (which handles its own scoring/promotion).
    Never raises - a failed sweep just logs and the next scheduled sweep
    tries again."""
    run_id = await growth_db.start_review_run(config)
    sessions_scanned = 0
    chunks_reviewed = 0
    try:
        since = await growth_db.get_review_cursor(config)
        turns = await growth_db.list_unreviewed_review_turns(config, since, limit=batch_size)
        if not turns:
            if run_id:
                await growth_db.finish_review_run(config, run_id, 0, 0, "complete")
            return {"sessionsScanned": 0, "chunksReviewed": 0}

        by_session: dict[str, list[dict]] = {}
        for t in turns:
            by_session.setdefault(t["session_id"], []).append(t)
        sessions_scanned = len(by_session)

        latest_occurred_at = since
        for session_id, session_turns in by_session.items():
            transcript = growth_judge.format_transcript(session_turns)
            judge = await growth_judge.run_judge(config, transcript)
            if judge is None:
                continue
            chunks_reviewed += 1
            turn_ids = [t["id"] for t in session_turns]
            persona_hash = session_turns[-1].get("persona_prompt_hash")
            model = session_turns[-1].get("model") or config.chat_model
            await growth_db.record_review_score(config, session_id, 0, turn_ids, persona_hash, model, judge)

            for attr in judge.attributions:
                category = _ACTIONABLE_ATTRIBUTION_CATEGORY.get(attr.type)
                if category is None or attr.confidence < _MIN_ATTRIBUTION_CONFIDENCE:
                    continue
                summary = attr.suggested_fix_area or attr.evidence
                await growth_db.record_observation(
                    config,
                    "review_score",
                    summary,
                    {"attributionType": attr.type, "confidence": attr.confidence, "evidence": attr.evidence, "sessionId": session_id},
                    session_id=session_id,
                    category=category,
                )

            for t in session_turns:
                if t["occurred_at"] and (latest_occurred_at is None or t["occurred_at"] > latest_occurred_at):
                    latest_occurred_at = t["occurred_at"]

        if latest_occurred_at and latest_occurred_at != since:
            await growth_db.set_review_cursor(config, latest_occurred_at)

        if run_id:
            await growth_db.finish_review_run(config, run_id, sessions_scanned, chunks_reviewed, "complete")
        return {"sessionsScanned": sessions_scanned, "chunksReviewed": chunks_reviewed}
    except Exception:
        logger.exception("growth_background.run_sweep failed")
        if run_id:
            await growth_db.finish_review_run(config, run_id, sessions_scanned, chunks_reviewed, "error")
        return {"sessionsScanned": sessions_scanned, "chunksReviewed": chunks_reviewed, "error": True}


async def start_background_loop(config: Config, interval_seconds: int = _DEFAULT_INTERVAL_SECONDS) -> None:
    """Fire-and-forget loop, started once at app startup (main.py). Sleeps
    first so a container restart doesn't immediately hit every dependency
    before the rest of the stack (Ollama, Postgres) is confirmed ready."""
    await asyncio.sleep(60)
    while True:
        try:
            result = await run_sweep(config)
            logger.info("growth_background sweep complete: %s", result)
        except Exception:
            logger.exception("growth_background loop iteration failed unexpectedly")
        await asyncio.sleep(interval_seconds)
