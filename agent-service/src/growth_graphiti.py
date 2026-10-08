"""Growth engine follow-up: wires the Growth lifecycle into graphiti-service,
the "decision/project/growth ledger" graph the target architecture (docs/
unified-architecture-gap-analysis.md §10) puts Growth's development history
under. Growth previously wrote exclusively to Postgres (growth_history) -
real, but invisible to the one system this project already built
specifically to hold "relationships, decisions, development history."

Same request shape and fire-and-forget convention event-bus/knowledge-engine
already use for their own episodes (POST /episodes, body {name, episodeBody,
sourceDescription}) - only fires at meaningful lifecycle moments (proposed,
consolidated), not every raw observation, matching their own "a real goal/
entity is a meaningful moment, not every event" precedent.
"""

from __future__ import annotations

import logging

import httpx

from .config import Config

logger = logging.getLogger(__name__)


async def add_episode(config: Config, name: str, episode_body: str, source_description: str) -> None:
    """Fire-and-forget: a slow/unreachable graphiti-service must never
    delay or break a Growth lifecycle transition."""
    try:
        async with httpx.AsyncClient() as client:
            # graphiti-core does LLM-based entity extraction per episode
            # (an Ollama call), not a quick DB write - a short timeout here
            # (like the research-queue/entity-create clients' 10s) was
            # found live to time out under real load. Still fire-and-
            # forget from the caller's perspective either way.
            await client.post(
                f"{config.graphiti_service_url}/episodes",
                json={"name": name, "episodeBody": episode_body, "sourceDescription": source_description},
                timeout=60,
            )
    except Exception:
        logger.exception("growth_graphiti.add_episode failed (name=%s)", name)
