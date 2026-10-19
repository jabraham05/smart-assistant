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
phase.

Runs once per night (3am local, not a fixed 30-minute interval anymore) -
real, live-verified reason for the change: this loop's own Ollama calls
(judge scoring, and growth_planner's research-brief scoping once that
shipped) share the single GPU this whole stack runs on with live chat.
Firing every 30 minutes around the clock meant it could - and did -
start mid-conversation and compound chat latency under load (confirmed:
classify and growth_judge both hit real timeouts during a live test
session, and a turn that tripped several of main.py's sequential
safety-net retries afterward took minutes instead of seconds). Moving
this to a single nightly window removes that contention instead of
trying to out-schedule it, at the cost of Growth's own signals being up
to a day stale - an acceptable tradeoff since nothing here blocks or
affects the live chat path directly, only how quickly a recurring issue
gets surfaced. The run drains everything accumulated since the previous
night in one pass (not capped to one batch), so a full day's backlog
still gets processed, just overnight instead of trickling through the
day competing with real usage.

Tier 1 only (per the autonomy model, docs/unified-architecture-gap-
analysis.md §8): judging conversations, recording observations, scoring/
promoting opportunities into proposals are all autonomous. Nothing in this
loop ever approves or consolidates a proposal - that still requires an
explicit human decision via growth_review (Tier 2)."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import growth_db, growth_judge, growth_planner
from .config import Config

logger = logging.getLogger(__name__)

# Same local-timezone convention system_prompt.py already uses for "today"/
# "now" framing in the persona prompt - one definition of "local" for this
# whole project, not a second, possibly-drifting one.
_LOCAL_TZ = ZoneInfo("America/Los_Angeles")
_NIGHTLY_RUN_HOUR = 3  # 3am local - well outside any realistic chat session.
# Safety valve, not an expected ceiling: at 20 turns/pass (run_sweep's own
# default batch_size), this covers 1000 turns in one night before giving up
# and waiting for the next one - far beyond any single user's real daily
# volume. Exists so a bug that keeps manufacturing "unreviewed" work can't
# turn one nightly run into an unbounded loop that's still going at noon.
_MAX_SWEEP_PASSES_PER_NIGHT = 50

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


async def retry_pending_knowledge_research(config: Config, limit: int = 2) -> int:
    """Retry abandoned Planner/queue attempts; queue-level dedup makes this idempotent."""
    try:
        plans = await growth_db.list_retryable_knowledge_plans(config, limit=limit)
    except Exception:
        logger.exception("Growth could not list retryable knowledge plans")
        return 0
    completed = 0
    for plan in plans:
        try:
            observations = await growth_db.list_observations_for_opportunity(config, plan["opportunity_id"])
            evidence = "\n".join(
                f"- {o['summary']} (evidence: {str(o.get('evidence') or '')[:600]})"
                for o in observations[-12:]
            ) or plan.get("description", "")
            result = await growth_planner.plan_and_enqueue(
                config, plan["title"], evidence, plan["opportunity_id"]
            )
            if not result.get("completed"):
                continue
            await growth_db.advance_learning_plan_step(config, plan["plan_id"], 1, "completed")
            await growth_db.finish_learning_plan(config, plan["plan_id"], "complete")
            await growth_db.insert_growth_history(
                config,
                "research_planning_retried",
                {"researchPlanning": result},
                opportunity_id=plan["opportunity_id"],
                proposal_id=plan["proposal_id"],
            )
            completed += 1
        except Exception:
            logger.exception("Growth failed retrying knowledge plan %s", plan.get("plan_id"))
    return completed


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
            await retry_pending_knowledge_research(config)
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

        await retry_pending_knowledge_research(config)

        if run_id:
            await growth_db.finish_review_run(config, run_id, sessions_scanned, chunks_reviewed, "complete")
        return {"sessionsScanned": sessions_scanned, "chunksReviewed": chunks_reviewed}
    except Exception:
        logger.exception("growth_background.run_sweep failed")
        if run_id:
            await growth_db.finish_review_run(config, run_id, sessions_scanned, chunks_reviewed, "error")
        return {"sessionsScanned": sessions_scanned, "chunksReviewed": chunks_reviewed, "error": True}


def _seconds_until_next_run(now_utc: datetime, run_hour: int) -> float:
    """Next occurrence of run_hour:00 in _LOCAL_TZ, at least 60s out - the
    60s floor keeps the old startup-grace behavior (don't immediately hit
    Ollama/Postgres before the rest of the stack is confirmed ready) for
    the one realistic edge case where a restart happens to land right at
    the nightly run time itself."""
    local_now = now_utc.astimezone(_LOCAL_TZ)
    target = local_now.replace(hour=run_hour, minute=0, second=0, microsecond=0)
    if target <= local_now:
        target += timedelta(days=1)
    return max(60.0, (target - local_now).total_seconds())


async def start_background_loop(config: Config, run_hour: int = _NIGHTLY_RUN_HOUR) -> None:
    """Fire-and-forget loop, started once at app startup (main.py). Sleeps
    until the next run_hour:00 _LOCAL_TZ, then drains every pending item
    (looping run_sweep, not a single batch_size=20 call) before going back
    to sleep until the following night - see the module docstring for why
    this moved off a fixed interval."""
    while True:
        await asyncio.sleep(_seconds_until_next_run(datetime.now(timezone.utc), run_hour))
        passes = 0
        while passes < _MAX_SWEEP_PASSES_PER_NIGHT:
            passes += 1
            try:
                result = await run_sweep(config)
            except Exception:
                logger.exception("growth_background loop iteration failed unexpectedly")
                break
            logger.info("growth_background sweep complete (pass %d): %s", passes, result)
            if result.get("error") or not result.get("sessionsScanned"):
                break
        logger.info("growth_background nightly run finished after %d pass(es)", passes)
