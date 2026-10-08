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

import hashlib
import json
import logging

import asyncpg

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
