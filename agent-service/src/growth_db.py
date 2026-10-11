"""Direct Postgres access for the Growth engine's own database (Phase 6.1 -
see docs/unified-architecture-gap-analysis.md §7 and docs/growth-engine.md).
Growth lives inside agent-service rather than as its own microservice, per
the roadmap ("move the lifecycle into agent-service and the current
architecture, do not resurrect the old n8n implementation") - but keeps its
own database, same one-database-per-concern convention as memory/events/
research/skills.

Reuses the schema design from the abandoned self-improvement pipeline
(commit 96a56acd, never merged) without reviving its n8n implementation:
persona_snapshots + review_turns are the raw capture mechanism, ported
verbatim and wired as a side effect of main.py's existing post-turn
persistence step. Everything past that (scoring, classification,
experiments, consolidation) is schema-only until Phase 6.2+ wires real
logic on top - this module only ever writes an observation, never acts
autonomously, so it needs no approval-tier gating of its own.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone

import asyncpg

from . import growth_graphiti
from .config import Config

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None


async def _get_pool(config: Config) -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            host=config.postgres.host,
            port=config.postgres.port,
            database=config.postgres.growth_database,
            user=config.postgres.user,
            password=config.postgres.password,
        )
    return _pool


async def _ensure_persona_snapshot(pool: asyncpg.Pool, persona_system_prompt: str) -> str:
    # Computed in Python rather than SQL's md5() - unlike the Code-node
    # sandbox gotcha that motivated computing hashes in SQL for the
    # original n8n pipeline, asyncpg/Python has no equivalent crypto-import
    # footgun, so there's no reason to push this into the query.
    prompt_hash = hashlib.md5(persona_system_prompt.encode("utf-8")).hexdigest()
    await pool.execute(
        "INSERT INTO persona_snapshots (hash, system_prompt) VALUES ($1, $2) "
        "ON CONFLICT (hash) DO NOTHING",
        prompt_hash,
        persona_system_prompt,
    )
    return prompt_hash


async def log_review_turn(
    config: Config,
    session_id: str,
    persona_system_prompt: str,
    user_message: str,
    agent_reply: str,
    tool_calls: list[str],
    user_card_snapshot: list[str],
    user_card_for_amy_snapshot: list[str],
    model: str,
) -> None:
    """Raw per-turn capture for the Growth engine - mirrors the Honcho/
    memory-engine writes already happening alongside this call in main.py.
    Never raises: this is awaited in the same gather as those writes, and a
    failure here must not affect a reply that has already streamed back to
    the user."""
    try:
        pool = await _get_pool(config)
        prompt_hash = await _ensure_persona_snapshot(pool, persona_system_prompt)
        await pool.execute(
            "INSERT INTO review_turns "
            "(session_id, user_message, agent_reply, tool_calls, persona_prompt_hash, "
            " user_card_snapshot, user_card_for_amy_snapshot, model) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            session_id,
            user_message,
            agent_reply,
            json.dumps(tool_calls),
            prompt_hash,
            json.dumps(user_card_snapshot),
            json.dumps(user_card_for_amy_snapshot),
            model,
        )
    except Exception:
        logger.exception("growth_db.log_review_turn failed for session %s", session_id)


# ============================================================
# Phase 6.2/6.3: opportunity scoring + classification
# ============================================================

# Deterministic per-source heuristic defaults for the five positive
# dimensions (frequency is tracked separately via accumulation) - mirrors
# this project's general preference for rule-based routing where possible
# (event-bus's classify.ts, knowledge-engine's router.ts) rather than an
# LLM call on every single observation. A starting point, not a claim of
# precision - review_score observations (Phase 6.4) carry a confidence
# derived from the judge's own attribution instead of this fixed default.
_SOURCE_DEFAULTS: dict[str, dict[str, float]] = {
    "tool_failure": {"usefulness": 3, "confidence": 4, "reuse_potential": 2, "improvement_value": 3, "effort": 2, "interruption_cost": 1},
    "safety_net_failure": {"usefulness": 3, "confidence": 4, "reuse_potential": 2, "improvement_value": 3, "effort": 2, "interruption_cost": 1},
    "user_correction": {"usefulness": 4, "confidence": 4, "reuse_potential": 3, "improvement_value": 4, "effort": 2, "interruption_cost": 2},
    "behavior_feedback": {"usefulness": 3, "confidence": 3, "reuse_potential": 3, "improvement_value": 3, "effort": 2, "interruption_cost": 2},
    "knowledge_gap": {"usefulness": 3, "confidence": 3, "reuse_potential": 2, "improvement_value": 2, "effort": 1, "interruption_cost": 1},
    "idle_reflection": {"usefulness": 2, "confidence": 2, "reuse_potential": 2, "improvement_value": 2, "effort": 2, "interruption_cost": 2},
    "skill_gap_scan": {"usefulness": 3, "confidence": 3, "reuse_potential": 3, "improvement_value": 3, "effort": 3, "interruption_cost": 2},
    "review_score": {"usefulness": 3, "confidence": 3, "reuse_potential": 2, "improvement_value": 3, "effort": 3, "interruption_cost": 2},
    # Phase 10 (Teaching layer): 'teaching_session' covers demonstration/
    # guided_practice - genuine evidence, but not deliberately complete, so
    # it needs a second occurrence (PROPOSAL_MIN_FREQUENCY) like any other
    # observed signal. 'teaching_session_explicit' is explain_and_build
    # specifically - the user gave a complete, deliberate procedure, which
    # is exactly the kind of single-occurrence evidence the high-confidence
    # shortcut (PROPOSAL_HIGH_CONFIDENCE/_SCORE_THRESHOLD below) exists for.
    "teaching_session": {"usefulness": 4, "confidence": 3, "reuse_potential": 3, "improvement_value": 3, "effort": 2, "interruption_cost": 2},
    "teaching_session_explicit": {"usefulness": 4, "confidence": 5, "reuse_potential": 3, "improvement_value": 4, "effort": 2, "interruption_cost": 1},
}
_DEFAULT_SCORE_DIMENSIONS = {
    "usefulness": 2, "confidence": 2, "reuse_potential": 2, "improvement_value": 2, "effort": 2, "interruption_cost": 2,
}

# source -> Growth category (Phase 6.3). behaviorFeedback's own sub-category
# (classify.py's BEHAVIOR_FEEDBACK_CATEGORIES) is more specific and spans
# more than one Growth category - e.g. 'tool_selection' feedback is really
# about a tool/skill, not a persona behavior change - so it's resolved
# separately in classify_category below rather than collapsed here.
_SOURCE_CATEGORY: dict[str, str] = {
    "knowledge_gap": "knowledge",
    "tool_failure": "tool",
    "skill_gap_scan": "skill",
    "idle_reflection": "behavior",
    "review_score": "behavior",
    "safety_net_failure": "behavior",
    "user_correction": "behavior",
}
_BEHAVIOR_FEEDBACK_CATEGORY_MAP: dict[str, str] = {
    "tool_selection": "tool",
    "memory_retrieval": "behavior",
    "communication": "behavior",
    "planning": "behavior",
    "proactivity": "behavior",
    "other": "behavior",
}

# An opportunity is proposed once it clears both a minimum score AND has
# been seen more than once - generalizes 96a56acd's own evidence threshold
# ("≥2 qualifying attributions in 14 days, or one at confidence ≥0.9") past
# persona review to every Growth category.
PROPOSAL_SCORE_THRESHOLD = 8.0
PROPOSAL_MIN_FREQUENCY = 2
PROPOSAL_HIGH_CONFIDENCE = 4.5
PROPOSAL_HIGH_CONFIDENCE_SCORE_THRESHOLD = 5.0

# The autonomy model (docs/unified-architecture-gap-analysis.md §8), made
# real instead of every proposal defaulting to tier2 regardless of
# category. §8's Tier 1 list includes "learn factual knowledge" - a
# knowledge-category proposal is exactly that, so it auto-approves and
# auto-consolidates with no human in the loop. Every other category
# matches §8's Tier 2 list verbatim ("activating a new skill," "changing
# persona behavior," - and 'tool' proposals are treated the same way since
# they still mean "installing/adding capabilities" even though they only
# ever land in an existing human-review queue). Tier 3 isn't represented
# here at all: nothing in the Growth engine ever touches identity/safety/
# permissions/tool-access tables, so there's no code path that could reach
# tier3 regardless of this map.
APPROVAL_TIER_BY_CATEGORY: dict[str, str] = {
    "knowledge": "tier1",
    "skill": "tier2",
    "tool": "tier2",
    "behavior": "tier2",
}


def classify_category(source: str, behavior_feedback_category: str | None = None) -> str | None:
    if source == "behavior_feedback" and behavior_feedback_category:
        return _BEHAVIOR_FEEDBACK_CATEGORY_MAP.get(behavior_feedback_category, "behavior")
    return _SOURCE_CATEGORY.get(source)


def compute_score(
    frequency: float,
    usefulness: float,
    confidence: float,
    reuse_potential: float,
    improvement_value: float,
    effort: float,
    interruption_cost: float,
) -> float:
    """The roadmap's scoring model, verbatim: frequency + usefulness +
    confidence + reuse_potential + improvement_value - effort -
    interruption_cost. A pure function so it can be unit-tested/tuned
    independently of the Postgres accumulation logic around it."""
    return frequency + usefulness + confidence + reuse_potential + improvement_value - effort - interruption_cost


def _draft_proposal_text(opp: asyncpg.Record) -> tuple[str, str]:
    category = opp["category"] or "behavior"
    title = opp["title"]
    if category == "knowledge":
        action = f"Research and record durable knowledge about: {title}"
    elif category == "skill":
        action = f"Author or improve a skill addressing: {title}"
    elif category == "tool":
        action = f"Evaluate a new tool/integration for: {title}"
    else:
        action = f"Review and adjust behavior/persona guidance regarding: {title}"
    score = opp["score"]
    rationale = (
        f"Observed {opp['frequency']} time(s), accumulated score "
        f"{float(score):.1f} (threshold {PROPOSAL_SCORE_THRESHOLD}). {opp['description']}"
    )
    return action, rationale


async def _maybe_promote(config: Config, opportunity_id: int) -> None:
    """Phase 6.2's selectivity gate - signal -> observation -> accumulate ->
    score -> propose ONLY when worthwhile, never signal -> proposal
    directly. Idempotent: an opportunity already proposed/rejected/dormant
    is left alone."""
    pool = await _get_pool(config)
    opp = await pool.fetchrow(
        "SELECT id, title, description, category, frequency, confidence, score, status "
        "FROM growth_opportunities WHERE id = $1",
        opportunity_id,
    )
    if not opp or opp["status"] in ("proposed", "rejected", "dormant"):
        return

    score = opp["score"]
    confidence = opp["confidence"]
    qualifies = (
        score is not None and float(score) >= PROPOSAL_SCORE_THRESHOLD and opp["frequency"] >= PROPOSAL_MIN_FREQUENCY
    ) or (
        confidence is not None
        and float(confidence) >= PROPOSAL_HIGH_CONFIDENCE
        and score is not None
        and float(score) >= PROPOSAL_HIGH_CONFIDENCE_SCORE_THRESHOLD
    )
    if not qualifies:
        if opp["status"] == "observed" and score is not None and float(score) >= PROPOSAL_SCORE_THRESHOLD:
            await pool.execute(
                "UPDATE growth_opportunities SET status = 'scored', updated_at = now() WHERE id = $1", opportunity_id
            )
        return

    await _create_proposal_from_opportunity(config, pool, opp)


async def _create_proposal_from_opportunity(config: Config, pool: asyncpg.Pool, opp: asyncpg.Record) -> int:
    """Shared by the automatic selectivity gate above and
    promote_opportunity_to_proposal's manual override below - the actual
    proposal-creation mechanics (insert, history, Graphiti episode, Tier 1
    auto-consolidation) are identical either way; only how the decision to
    create one was reached differs."""
    opportunity_id = opp["id"]
    score = opp["score"]
    category = opp["category"] or "behavior"
    tier = APPROVAL_TIER_BY_CATEGORY.get(category, "tier2")
    is_tier1 = tier == "tier1"
    proposed_action, rationale = _draft_proposal_text(opp)
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            "INSERT INTO growth_proposals (opportunity_id, category, proposed_action, rationale, approval_tier, status, reviewed_at, reviewer_notes) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
            opportunity_id,
            category,
            proposed_action,
            rationale,
            tier,
            "approved" if is_tier1 else "proposed",
            datetime.now(timezone.utc) if is_tier1 else None,
            "auto-approved: Tier 1 (knowledge) per the autonomy model" if is_tier1 else None,
        )
        await conn.execute(
            "UPDATE growth_opportunities SET status = 'proposed', updated_at = now() WHERE id = $1", opportunity_id
        )
        await conn.execute(
            "INSERT INTO growth_history (opportunity_id, proposal_id, event_type, detail) "
            "VALUES ($1, $2, 'proposed', $3)",
            opportunity_id,
            row["id"],
            json.dumps({"category": category, "score": float(score) if score is not None else None, "tier": tier}),
        )
    logger.info(
        "growth_db: promoted opportunity %s to proposal %s (score=%s frequency=%s tier=%s)",
        opportunity_id,
        row["id"],
        score,
        opp["frequency"],
        tier,
    )
    asyncio.create_task(
        growth_graphiti.add_episode(
            config,
            f"growth-proposal-{row['id']}",
            f"Amy's Growth engine proposed a {category} improvement: {opp['title']}. {rationale}",
            "growth_engine proposed event",
        )
    )

    if is_tier1:
        # Deferred import - growth_consolidate imports this module, so this
        # has to be a late binding to avoid a circular import. Tier 1 means
        # "no human in the loop," so the auto-approval above goes straight
        # to consolidation in the same call rather than waiting for
        # anything else to notice the 'approved' status.
        from . import growth_consolidate

        await growth_consolidate.consolidate_proposal(config, row["id"])

    return row["id"]


async def set_opportunity_status(config: Config, opportunity_id: int, status: str) -> None:
    """Growth dashboard's dismiss ('rejected') / defer ('dormant') actions -
    a human deciding an opportunity isn't worth pursuing (or isn't worth
    pursuing yet) without waiting for it to ever reach the scoring
    threshold on its own."""
    try:
        pool = await _get_pool(config)
        await pool.execute(
            "UPDATE growth_opportunities SET status = $2, updated_at = now() WHERE id = $1", opportunity_id, status
        )
        await insert_growth_history(config, status, {"manual": True}, opportunity_id=opportunity_id)
    except Exception:
        logger.exception("growth_db.set_opportunity_status failed (id=%s, status=%s)", opportunity_id, status)


async def promote_opportunity_to_proposal(config: Config, opportunity_id: int) -> int | None:
    """Growth dashboard's manual 'promote' action - the human override for
    _maybe_promote's automatic threshold. A human looking at the evidence
    can judge something is worth proposing before it has recurred enough
    to clear the score/frequency gate on its own; this bypasses that gate
    but goes through the exact same creation path (including Tier 1 auto-
    consolidation, if the category qualifies) so the result is
    indistinguishable from an automatic promotion."""
    try:
        pool = await _get_pool(config)
        opp = await pool.fetchrow(
            "SELECT id, title, description, category, frequency, confidence, score, status "
            "FROM growth_opportunities WHERE id = $1",
            opportunity_id,
        )
        if not opp or opp["status"] in ("proposed", "rejected", "dormant"):
            return None
        return await _create_proposal_from_opportunity(config, pool, opp)
    except Exception:
        logger.exception("growth_db.promote_opportunity_to_proposal failed (id=%s)", opportunity_id)
        return None


async def record_observation(
    config: Config,
    source: str,
    summary: str,
    evidence: dict,
    session_id: str | None = None,
    category: str | None = None,
) -> int | None:
    """Raw signal -> accumulated, scored opportunity (Phase 6.2/6.3). Never
    raises - every call site fires this as a best-effort side observation,
    same fail-silent convention as log_review_turn above. Dedup/
    accumulation matches on a normalized title rather than an embedding
    search - deterministic and good enough for now; Phase 6.2 follow-up
    work can swap in similarity matching without changing this function's
    signature. Returns the opportunity id touched, or None on failure."""
    try:
        pool = await _get_pool(config)
        category = category or classify_category(source)
        title = summary.strip()[:200]
        if not title:
            return None

        async with pool.acquire() as conn, conn.transaction():
            existing = await conn.fetchrow(
                "SELECT id, frequency FROM growth_opportunities "
                "WHERE lower(title) = lower($1) AND status NOT IN ('rejected', 'dormant') "
                "ORDER BY id DESC LIMIT 1",
                title,
            )
            defaults = _SOURCE_DEFAULTS.get(source, _DEFAULT_SCORE_DIMENSIONS)
            if existing:
                opportunity_id = existing["id"]
                frequency = existing["frequency"] + 1
                score = compute_score(frequency, **defaults)
                await conn.execute(
                    "UPDATE growth_opportunities SET frequency = $2, score = $3, "
                    "last_observed_at = now(), updated_at = now() WHERE id = $1",
                    opportunity_id,
                    frequency,
                    score,
                )
            else:
                frequency = 1
                score = compute_score(frequency, **defaults)
                row = await conn.fetchrow(
                    "INSERT INTO growth_opportunities "
                    "(title, description, category, frequency, usefulness, confidence, "
                    " reuse_potential, improvement_value, effort, interruption_cost, score, status) "
                    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'observed') RETURNING id",
                    title,
                    summary,
                    category,
                    frequency,
                    defaults["usefulness"],
                    defaults["confidence"],
                    defaults["reuse_potential"],
                    defaults["improvement_value"],
                    defaults["effort"],
                    defaults["interruption_cost"],
                    score,
                )
                opportunity_id = row["id"]

            await conn.execute(
                "INSERT INTO growth_observations (source, category, summary, evidence, session_id, opportunity_id) "
                "VALUES ($1, $2, $3, $4, $5, $6)",
                source,
                category,
                summary,
                json.dumps(evidence),
                session_id,
                opportunity_id,
            )
            await conn.execute(
                "INSERT INTO growth_history (opportunity_id, event_type, detail) VALUES ($1, 'observed', $2)",
                opportunity_id,
                json.dumps({"source": source, "summary": summary}),
            )

        await _maybe_promote(config, opportunity_id)
        return opportunity_id
    except Exception:
        logger.exception("growth_db.record_observation failed (source=%s)", source)
        return None


# ============================================================
# Read/review access for the growth_review tool (Phase 6.5)
# ============================================================


async def list_opportunities(config: Config, status: str | None = None, limit: int = 50) -> list[dict]:
    pool = await _get_pool(config)
    if status:
        rows = await pool.fetch(
            "SELECT * FROM growth_opportunities WHERE status = $1 "
            "ORDER BY score DESC NULLS LAST, updated_at DESC LIMIT $2",
            status,
            limit,
        )
    else:
        rows = await pool.fetch(
            "SELECT * FROM growth_opportunities ORDER BY score DESC NULLS LAST, updated_at DESC LIMIT $1", limit
        )
    return [dict(r) for r in rows]


async def list_proposals(config: Config, status: str | None = None, limit: int = 50) -> list[dict]:
    pool = await _get_pool(config)
    if status:
        rows = await pool.fetch(
            "SELECT * FROM growth_proposals WHERE status = $1 ORDER BY created_at DESC LIMIT $2", status, limit
        )
    else:
        rows = await pool.fetch("SELECT * FROM growth_proposals ORDER BY created_at DESC LIMIT $1", limit)
    return [dict(r) for r in rows]


async def get_proposal(config: Config, proposal_id: int) -> dict | None:
    pool = await _get_pool(config)
    row = await pool.fetchrow(
        "SELECT p.*, o.title AS opportunity_title, o.description AS opportunity_description, "
        "o.confidence AS opportunity_confidence, o.score AS opportunity_score, "
        "o.frequency AS opportunity_frequency "
        "FROM growth_proposals p JOIN growth_opportunities o ON o.id = p.opportunity_id WHERE p.id = $1",
        proposal_id,
    )
    return dict(row) if row else None


async def save_proposal_preview(
    config: Config,
    proposal_id: int,
    current_text: str,
    proposed_text: str,
    evaluation: dict | None,
) -> None:
    """Persists what preview_proposal() computed so (1) a human reviewing the
    Review Queue sees real candidate text instead of just a rationale, and
    (2) consolidate_proposal() can reuse it instead of regenerating - what
    gets approved is exactly what was previewed, not a second, possibly
    different LLM generation."""
    pool = await _get_pool(config)
    await pool.execute(
        "UPDATE growth_proposals SET current_text = $2, proposed_text = $3, "
        "preview_evaluation = $4, previewed_at = now() WHERE id = $1",
        proposal_id,
        current_text,
        proposed_text,
        json.dumps(evaluation) if evaluation is not None else None,
    )


async def get_proposal_by_opportunity(config: Config, opportunity_id: int) -> dict | None:
    pool = await _get_pool(config)
    row = await pool.fetchrow(
        "SELECT * FROM growth_proposals WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1",
        opportunity_id,
    )
    return dict(row) if row else None


async def set_proposal_status(config: Config, proposal_id: int, status: str, notes: str | None = None) -> None:
    pool = await _get_pool(config)
    await pool.execute(
        "UPDATE growth_proposals SET status = $2, reviewed_at = now(), reviewer_notes = $3 WHERE id = $1",
        proposal_id,
        status,
        notes,
    )
    await pool.execute(
        "INSERT INTO growth_history (proposal_id, event_type, detail) VALUES ($1, $2, $3)",
        proposal_id,
        status,
        json.dumps({"notes": notes}),
    )


async def list_learning_plans(config: Config, status: str | None = None, limit: int = 50) -> list[dict]:
    """Growth dashboard's "Learning plans and experiments" section - what
    Amy is trying to improve and why, joined back to the proposal/
    opportunity it's acting on so the dashboard can show the full chain
    without a second round-trip per row."""
    pool = await _get_pool(config)
    query = (
        "SELECT lp.*, p.category AS proposal_category, p.proposed_action, o.title AS opportunity_title "
        "FROM learning_plans lp "
        "JOIN growth_proposals p ON p.id = lp.proposal_id "
        "JOIN growth_opportunities o ON o.id = p.opportunity_id "
    )
    if status:
        query += "WHERE lp.status = $1 ORDER BY lp.created_at DESC LIMIT $2"
        rows = await pool.fetch(query, status, limit)
    else:
        query += "ORDER BY lp.created_at DESC LIMIT $1"
        rows = await pool.fetch(query, limit)
    return [dict(r) for r in rows]


async def list_experiments(config: Config, limit: int = 50) -> list[dict]:
    """Experiments joined with their evaluation (one-to-one in practice -
    every experiment this project creates gets exactly one evaluation
    recorded against it) so the dashboard can show "what was tested, what
    happened" in one row instead of two lookups."""
    pool = await _get_pool(config)
    rows = await pool.fetch(
        "SELECT e.*, ev.id AS evaluation_id, ev.metric, ev.baseline_score, ev.candidate_score, "
        "ev.improved, ev.baseline_results, ev.candidate_results, ev.notes AS evaluation_notes, "
        "ev.evaluated_at, p.category AS proposal_category, o.title AS opportunity_title "
        "FROM experiments e "
        "LEFT JOIN evaluations ev ON ev.experiment_id = e.id "
        "LEFT JOIN growth_proposals p ON p.id = e.proposal_id "
        "LEFT JOIN growth_opportunities o ON o.id = p.opportunity_id "
        "ORDER BY e.created_at DESC LIMIT $1",
        limit,
    )
    return [dict(r) for r in rows]


async def list_growth_history(config: Config, limit: int = 100) -> list[dict]:
    """The durable record the dashboard's "Growth history" section shows -
    what changed, tied back to the opportunity/proposal it came from.
    Append-only; nothing in this module ever updates or deletes a row
    here."""
    pool = await _get_pool(config)
    rows = await pool.fetch(
        "SELECT h.*, o.title AS opportunity_title, p.category AS proposal_category "
        "FROM growth_history h "
        "LEFT JOIN growth_opportunities o ON o.id = h.opportunity_id "
        "LEFT JOIN growth_proposals p ON p.id = h.proposal_id "
        "ORDER BY h.created_at DESC LIMIT $1",
        limit,
    )
    return [dict(r) for r in rows]


async def record_review_score(
    config: Config,
    session_id: str,
    chunk_index: int,
    turn_ids: list[int],
    persona_prompt_hash: str | None,
    model: str,
    judge,  # growth_judge.JudgeOutput - typed there, not here, to avoid a circular import
) -> int | None:
    """Phase 6.4: persists one judge run (five rubric scores + its
    one-to-many attributions) against a contiguous slice of review_turns."""
    try:
        pool = await _get_pool(config)
        async with pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                "INSERT INTO review_scores "
                "(session_id, chunk_index, turn_ids, persona_prompt_hash, model, task_success_score, "
                " relevance_score, persona_alignment_score, user_sentiment_score, followup_coherence_score, "
                " overall_notes, raw_judge_output, flagged_for_human) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",
                session_id,
                chunk_index,
                json.dumps(turn_ids),
                persona_prompt_hash,
                model,
                judge.task_success,
                judge.relevance,
                judge.persona_alignment,
                judge.user_sentiment,
                judge.followup_coherence,
                judge.overall_notes,
                judge.model_dump_json(by_alias=True),
                judge.flagged_for_human,
            )
            score_id = row["id"]
            for attr in judge.attributions:
                await conn.execute(
                    "INSERT INTO review_attributions "
                    "(review_score_id, attribution_type, confidence, evidence, suggested_fix_area) "
                    "VALUES ($1,$2,$3,$4,$5)",
                    score_id,
                    attr.type,
                    attr.confidence,
                    attr.evidence,
                    attr.suggested_fix_area,
                )
        return score_id
    except Exception:
        logger.exception("growth_db.record_review_score failed for session %s", session_id)
        return None


async def list_unreviewed_review_turns(config: Config, since: object, limit: int = 100) -> list[dict]:
    pool = await _get_pool(config)
    rows = await pool.fetch(
        "SELECT * FROM review_turns WHERE occurred_at > $1 ORDER BY occurred_at ASC LIMIT $2", since, limit
    )
    return [dict(r) for r in rows]


async def get_review_cursor(config: Config, key: str = "reviewer") -> object:
    pool = await _get_pool(config)
    row = await pool.fetchrow("SELECT last_reviewed_at FROM review_cursor WHERE key = $1", key)
    return row["last_reviewed_at"] if row else None


async def set_review_cursor(config: Config, when: object, key: str = "reviewer") -> None:
    pool = await _get_pool(config)
    await pool.execute(
        "UPDATE review_cursor SET last_reviewed_at = $2, updated_at = now() WHERE key = $1", key, when
    )


async def start_review_run(config: Config) -> int | None:
    pool = await _get_pool(config)
    row = await pool.fetchrow("INSERT INTO review_runs (status) VALUES ('running') RETURNING id")
    return row["id"]


async def finish_review_run(config: Config, run_id: int, sessions_scanned: int, chunks_reviewed: int, status: str) -> None:
    pool = await _get_pool(config)
    await pool.execute(
        "UPDATE review_runs SET finished_at = now(), sessions_scanned = $2, chunks_reviewed = $3, status = $4 "
        "WHERE id = $1",
        run_id,
        sessions_scanned,
        chunks_reviewed,
        status,
    )


async def list_golden_transcripts(config: Config) -> list[dict]:
    pool = await _get_pool(config)
    rows = await pool.fetch("SELECT * FROM golden_transcripts ORDER BY id")
    return [dict(r) for r in rows]


async def record_golden_regression_run(
    config: Config,
    golden_transcript_id: int,
    candidate_persona_hash: str,
    baseline_scores: dict,
    candidate_scores: dict,
    regressed: bool,
) -> None:
    pool = await _get_pool(config)
    await pool.execute(
        "INSERT INTO golden_regression_runs "
        "(golden_transcript_id, candidate_persona_hash, baseline_scores, candidate_scores, regressed) "
        "VALUES ($1,$2,$3,$4,$5)",
        golden_transcript_id,
        candidate_persona_hash,
        json.dumps(baseline_scores),
        json.dumps(candidate_scores),
        regressed,
    )


async def create_experiment(
    config: Config,
    description: str,
    baseline_definition: dict,
    candidate_definition: dict,
    learning_plan_id: int | None = None,
    proposal_id: int | None = None,
) -> int | None:
    try:
        pool = await _get_pool(config)
        row = await pool.fetchrow(
            "INSERT INTO experiments "
            "(learning_plan_id, proposal_id, description, baseline_definition, candidate_definition, status, started_at) "
            "VALUES ($1,$2,$3,$4,$5,'running',now()) RETURNING id",
            learning_plan_id,
            proposal_id,
            description,
            json.dumps(baseline_definition),
            json.dumps(candidate_definition),
        )
        return row["id"]
    except Exception:
        logger.exception("growth_db.create_experiment failed")
        return None


async def record_evaluation(
    config: Config,
    experiment_id: int,
    metric: str,
    baseline_score: float | None,
    candidate_score: float | None,
    baseline_results: dict,
    candidate_results: dict,
    notes: str | None = None,
    improved: bool | None = None,
) -> int | None:
    try:
        if improved is None and baseline_score is not None and candidate_score is not None:
            improved = candidate_score > baseline_score
        pool = await _get_pool(config)
        async with pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                "INSERT INTO evaluations "
                "(experiment_id, metric, baseline_score, candidate_score, improved, baseline_results, candidate_results, notes) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
                experiment_id,
                metric,
                baseline_score,
                candidate_score,
                improved,
                json.dumps(baseline_results),
                json.dumps(candidate_results),
                notes,
            )
            await conn.execute(
                "UPDATE experiments SET status = 'complete', finished_at = now() WHERE id = $1", experiment_id
            )
        return row["id"]
    except Exception:
        logger.exception("growth_db.record_evaluation failed")
        return None


# ============================================================
# Phase 6.5: consolidation writes into n8n's/skills-mcp's databases
# ============================================================

# Cache of pools for databases other than `growth` (keyed by database
# name) - used only by the three consolidation writers below. Kept
# separate from _get_pool/_pool above so a Growth-engine-only database
# outage never affects turn-logging, and so db.py's own "nothing here
# ever writes" invariant isn't bent to accommodate this.
_other_pools: dict[str, asyncpg.Pool] = {}


async def _get_pool_for(config: Config, database: str) -> asyncpg.Pool:
    if database not in _other_pools:
        _other_pools[database] = await asyncpg.create_pool(
            host=config.postgres.host,
            port=config.postgres.port,
            database=database,
            user=config.postgres.user,
            password=config.postgres.password,
        )
    return _other_pools[database]


# n8n's Data Table feature stores "skills"/"personas" as views over a
# table with a generated name (see db.py's own module docstring) - these
# are the real underlying tables, confirmed via `SELECT definition FROM
# pg_views WHERE viewname IN ('skills','personas')` against the live
# stack. Fixed, hardcoded identifiers, not user input - safe to embed
# directly in SQL text.
_SKILLS_TABLE = '"data_table_user_suWDTLC9t3H1ESud"'
_PERSONAS_TABLE = '"data_table_user_9E02ctNxKP8AGEqI"'


async def consolidate_skill(config: Config, name: str, description: str, instructions: str, reason: str) -> None:
    """Writes a new active instruction skill directly into n8n's
    Data-Table-backed skills table - the final automation step for an
    already-approved Growth proposal (approval already happened via
    growth_proposals.status='approved'; this is what a human would
    otherwise type into n8n's Data Table UI by hand). Uses its own
    connection rather than extending db.py's documented-read-only pool,
    so that invariant stays true for every other caller of db.py."""
    try:
        pool = await _get_pool_for(config, config.postgres.n8n_database)
        await pool.execute(
            f'INSERT INTO {_SKILLS_TABLE} '
            '(name, description, kind, instructions, reason, status, "createdAt", "updatedAt") '
            "VALUES ($1, $2, 'instruction', $3, $4, 'active', now(), now())",
            name,
            description,
            instructions,
            reason,
        )
    except Exception:
        logger.exception("growth_db.consolidate_skill failed (name=%s)", name)


async def propose_persona_edit(config: Config, name: str, proposed_system_prompt: str, reason: str) -> None:
    """Tier 2, always human-approved before promotion (postgres/init/25-add-
    persona-proposal-columns.sql): writes a candidate persona edit into the
    proposed_* columns without ever touching the live system_prompt itself -
    same never-auto-applies guarantee as every other self-authoring
    mechanism in this project."""
    try:
        pool = await _get_pool_for(config, config.postgres.n8n_database)
        await pool.execute(
            f'UPDATE {_PERSONAS_TABLE} '
            'SET proposed_system_prompt = $2, proposed_reason = $3, proposed_at = now(), "updatedAt" = now() '
            "WHERE name = $1",
            name,
            proposed_system_prompt,
            reason,
        )
    except Exception:
        logger.exception("growth_db.propose_persona_edit failed (name=%s)", name)


async def create_tool_idea_proposal(
    config: Config, name: str, description: str, reason: str, tool_idea_details: str
) -> None:
    """Routes a 'tool' category Growth proposal into the EXISTING
    skill_proposals human-review pipeline (skills DB, kind='tool_idea') -
    reuses infra that already exists rather than inventing a parallel
    review queue."""
    try:
        pool = await _get_pool_for(config, config.postgres.skills_database)
        await pool.execute(
            "INSERT INTO skill_proposals (kind, name, description, reason, tool_idea_details, status) "
            "VALUES ('tool_idea', $1, $2, $3, $4, 'proposed')",
            name,
            description,
            reason,
            tool_idea_details,
        )
    except Exception:
        logger.exception("growth_db.create_tool_idea_proposal failed (name=%s)", name)


# ============================================================
# Learning Plans - the missing step between an approved proposal
# and its experiment/consolidation (roadmap: Proposal -> Learning
# Plan -> Experiment -> Evaluation -> Approval/Decision -> Consolidation)
# ============================================================

# Deterministic per-category step templates - same rule-based-over-LLM-call
# preference as everywhere else in this module. A learning plan's steps are
# a fixed JSONB array, not a child table: plans are read/updated as a
# whole, never queried step-by-step.
LEARNING_PLAN_TEMPLATES: dict[str, list[str]] = {
    "knowledge": [
        "Confirm the fact/learning is accurate and self-contained",
        "Record it as a durable entity",
    ],
    "skill": [
        "Draft skill instructions from the opportunity's evidence",
        "Evaluate the draft against the opportunity's linked observations",
        "Write the skill if the evaluation looks sound",
    ],
    "behavior": [
        "Draft a candidate persona edit",
        "Run the golden-transcript regression check",
        "Submit the candidate for manual promotion",
    ],
    "tool": [
        "Draft a tool/integration idea",
        "Queue it for human review via skill_proposals",
    ],
}


async def list_observations_for_opportunity(config: Config, opportunity_id: int) -> list[dict]:
    pool = await _get_pool(config)
    rows = await pool.fetch(
        "SELECT * FROM growth_observations WHERE opportunity_id = $1 ORDER BY id", opportunity_id
    )
    return [dict(r) for r in rows]


async def create_learning_plan(config: Config, proposal_id: int, category: str) -> int | None:
    """Creates a plan from the fixed per-category template the moment a
    proposal is approved - this is what makes the roadmap's Learning Plan
    stage real instead of skipped straight from Proposal to Consolidation."""
    try:
        pool = await _get_pool(config)
        steps = [{"description": d, "status": "pending"} for d in LEARNING_PLAN_TEMPLATES.get(category, [])]
        goal = f"Act on an approved {category} proposal"
        row = await pool.fetchrow(
            "INSERT INTO learning_plans (proposal_id, goal, steps, status) VALUES ($1, $2, $3, 'active') RETURNING id",
            proposal_id,
            goal,
            json.dumps(steps),
        )
        await insert_growth_history(config, "learning_plan_created", {"planId": row["id"], "category": category}, proposal_id=proposal_id)
        return row["id"]
    except Exception:
        logger.exception("growth_db.create_learning_plan failed for proposal %s", proposal_id)
        return None


async def advance_learning_plan_step(config: Config, plan_id: int, step_index: int, status: str) -> None:
    """Read-modify-write on the steps JSONB array - plans are small (a
    handful of steps), so this is simpler and safer than a child table for
    something nothing ever needs to query by step across plans."""
    try:
        pool = await _get_pool(config)
        row = await pool.fetchrow("SELECT steps FROM learning_plans WHERE id = $1", plan_id)
        if not row:
            return
        steps = json.loads(row["steps"]) if isinstance(row["steps"], str) else row["steps"]
        if 0 <= step_index < len(steps):
            steps[step_index]["status"] = status
        await pool.execute(
            "UPDATE learning_plans SET steps = $2, updated_at = now() WHERE id = $1", plan_id, json.dumps(steps)
        )
    except Exception:
        logger.exception("growth_db.advance_learning_plan_step failed for plan %s", plan_id)


async def finish_learning_plan(config: Config, plan_id: int, status: str) -> None:
    try:
        pool = await _get_pool(config)
        await pool.execute(
            "UPDATE learning_plans SET status = $2, updated_at = now() WHERE id = $1", plan_id, status
        )
    except Exception:
        logger.exception("growth_db.finish_learning_plan failed for plan %s", plan_id)


async def get_persona_proposal(config: Config, name: str = "Amy") -> dict | None:
    """Follow-up fix: personas.proposed_system_prompt (postgres/init/25-add-
    persona-proposal-columns.sql) was only ever readable via raw SQL -
    including a real, unreviewed proposal from 2026-08-21 that predates
    the Growth engine entirely. This is what makes it visible through
    growth_review instead. Reads through the public.personas view (same
    one db.py's read-only get_persona_system_prompt uses), not the n8n
    write pool - a plain read needs no write access."""
    try:
        pool = await _get_pool_for(config, config.postgres.n8n_database)
        row = await pool.fetchrow(
            "SELECT name, system_prompt, proposed_system_prompt, proposed_reason, proposed_at "
            "FROM public.personas WHERE name = $1",
            name,
        )
        if not row or not row["proposed_system_prompt"]:
            return None
        return dict(row)
    except Exception:
        logger.exception("growth_db.get_persona_proposal failed (name=%s)", name)
        return None


# Real, live-verified finding: the 2026-08-21 proposal already sitting in
# this column (written by skill_gap_scanner's old persona-change branch,
# before this Growth engine existed) turned out to be a short reasoning
# paragraph about a suggested change, NOT a full drop-in replacement persona
# - promoting it as-is would have silently destroyed Amy's entire real,
# tuned system_prompt. Growth's OWN propose_persona_edit always writes a
# full current-persona-plus-addition text (growth_consolidate.py), so this
# guard only ever rejects genuinely malformed/legacy data, never Growth's
# own proposals. A deterministic length ratio, not a judge call - the same
# "don't trust a default, add a real check" instinct as calculate.ts.
PERSONA_PROMOTE_MIN_LENGTH_RATIO = 0.5


async def promote_persona_proposal(config: Config, name: str = "Amy") -> dict:
    """The one deliberately manual step in the whole Growth engine
    (Tier 2, docs/unified-architecture-gap-analysis.md §8: "changing
    persona behavior" always requires explicit human action) - this makes
    that action actually reachable conversationally via growth_review
    instead of requiring raw SQL, without changing the guarantee that it
    never happens automatically. Clears the proposed_* columns on success
    so the same proposal can't be promoted twice. Returns a dict rather
    than a bool so a rejected-for-safety case can explain why, instead of
    looking identical to "nothing was pending"."""
    try:
        pool = await _get_pool_for(config, config.postgres.n8n_database)
        async with pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                f'SELECT system_prompt, proposed_system_prompt FROM {_PERSONAS_TABLE} WHERE name = $1', name
            )
            if not row or not row["proposed_system_prompt"]:
                return {"ok": False, "reason": "no pending proposal"}

            current = row["system_prompt"] or ""
            proposed = row["proposed_system_prompt"]
            if current and len(proposed) < PERSONA_PROMOTE_MIN_LENGTH_RATIO * len(current):
                return {
                    "ok": False,
                    "reason": (
                        f"refused: proposed text ({len(proposed)} chars) is far shorter than the current "
                        f"persona ({len(current)} chars) - this looks like a reasoning note about a "
                        "suggested change, not a full replacement persona, and promoting it would likely "
                        "destroy most of the real persona. Read it via action='persona_proposal' and "
                        "resolve this by hand (edit the persona directly) instead."
                    ),
                }

            await conn.execute(
                f'UPDATE {_PERSONAS_TABLE} SET system_prompt = $2, proposed_system_prompt = NULL, '
                f'proposed_reason = NULL, proposed_at = NULL, "updatedAt" = now() WHERE name = $1',
                name,
                proposed,
            )
        await insert_growth_history(config, "persona_promoted", {"name": name})
        return {"ok": True}
    except Exception:
        logger.exception("growth_db.promote_persona_proposal failed (name=%s)", name)
        return {"ok": False, "reason": "internal error, see logs"}


async def dismiss_persona_proposal(config: Config, name: str = "Amy", reason: str | None = None) -> dict:
    """The reject counterpart to promote_persona_proposal - clears the
    proposed_* columns without ever touching system_prompt, so a reviewed
    and declined proposal (human decision, not Growth's own judgment)
    stops showing as pending forever instead of just being ignored."""
    try:
        pool = await _get_pool_for(config, config.postgres.n8n_database)
        async with pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                f'SELECT proposed_system_prompt FROM {_PERSONAS_TABLE} WHERE name = $1', name
            )
            if not row or not row["proposed_system_prompt"]:
                return {"ok": False, "reason": "no pending proposal"}
            await conn.execute(
                f'UPDATE {_PERSONAS_TABLE} SET proposed_system_prompt = NULL, proposed_reason = NULL, '
                f'proposed_at = NULL, "updatedAt" = now() WHERE name = $1',
                name,
            )
        await insert_growth_history(config, "persona_dismissed", {"name": name, "reason": reason})
        return {"ok": True}
    except Exception:
        logger.exception("growth_db.dismiss_persona_proposal failed (name=%s)", name)
        return {"ok": False, "reason": "internal error, see logs"}


async def insert_growth_history(
    config: Config,
    event_type: str,
    detail: dict,
    opportunity_id: int | None = None,
    proposal_id: int | None = None,
    entity_id: str | None = None,
) -> None:
    pool = await _get_pool(config)
    await pool.execute(
        "INSERT INTO growth_history (opportunity_id, proposal_id, event_type, detail, entity_id) "
        "VALUES ($1, $2, $3, $4, $5)",
        opportunity_id,
        proposal_id,
        event_type,
        json.dumps(detail),
        entity_id,
    )


# ============================================================
# Phase 10: Teaching sessions - one shared lifecycle for all three
# teaching modes (demonstration/guided_practice/explain_and_build). A
# teaching session captures raw instruction, gets classified, and is
# routed into the SAME record_observation()/growth_proposals pipeline
# every other signal uses (see growth_teaching.py) - this module only
# owns the raw capture + bookkeeping, same split as everywhere else here.
# ============================================================


async def create_teaching_session(
    config: Config, mode: str, session_id: str | None, initial_content: str
) -> int:
    pool = await _get_pool(config)
    row = await pool.fetchrow(
        "INSERT INTO teaching_sessions (session_id, mode, captured_content) VALUES ($1, $2, $3) RETURNING id",
        session_id,
        mode,
        initial_content,
    )
    await insert_growth_history(config, "teaching_session_started", {"mode": mode})
    return row["id"]


async def append_teaching_content(config: Config, teaching_session_id: int, text: str) -> None:
    pool = await _get_pool(config)
    await pool.execute(
        "UPDATE teaching_sessions SET captured_content = captured_content || E'\\n' || $2, updated_at = now() "
        "WHERE id = $1",
        teaching_session_id,
        text,
    )


async def get_teaching_session(config: Config, teaching_session_id: int) -> dict | None:
    pool = await _get_pool(config)
    row = await pool.fetchrow("SELECT * FROM teaching_sessions WHERE id = $1", teaching_session_id)
    return dict(row) if row else None


async def list_teaching_sessions(config: Config, status: str | None = None, limit: int = 50) -> list[dict]:
    pool = await _get_pool(config)
    if status:
        rows = await pool.fetch(
            "SELECT * FROM teaching_sessions WHERE status = $1 ORDER BY created_at DESC LIMIT $2", status, limit
        )
    else:
        rows = await pool.fetch("SELECT * FROM teaching_sessions ORDER BY created_at DESC LIMIT $1", limit)
    return [dict(r) for r in rows]


async def set_teaching_session_classification(
    config: Config,
    teaching_session_id: int,
    category: str,
    reasoning: str,
    procedure: str | None,
    rules: str | None,
    examples: str | None,
    open_questions: str | None,
) -> None:
    pool = await _get_pool(config)
    await pool.execute(
        "UPDATE teaching_sessions SET status = 'classified', category = $2, classification_reasoning = $3, "
        "extracted_procedure = $4, extracted_rules = $5, extracted_examples = $6, open_questions = $7, "
        "updated_at = now() WHERE id = $1",
        teaching_session_id,
        category,
        reasoning,
        procedure,
        rules,
        examples,
        open_questions,
    )


async def set_teaching_session_routing(
    config: Config,
    teaching_session_id: int,
    status: str,
    opportunity_id: int | None = None,
    proposal_id: int | None = None,
    entity_id: str | None = None,
) -> None:
    pool = await _get_pool(config)
    await pool.execute(
        "UPDATE teaching_sessions SET status = $2, opportunity_id = $3, proposal_id = $4, entity_id = $5, "
        "updated_at = now() WHERE id = $1",
        teaching_session_id,
        status,
        opportunity_id,
        proposal_id,
        entity_id,
    )
