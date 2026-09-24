"""Direct port of chat-orchestrator/src/knowledge-engine-client.ts."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from .config import Config

logger = logging.getLogger(__name__)


async def enqueue_research_topic(
    config: Config, topic: str, domain: str | None = None, session_id: str | None = None
) -> None:
    """The self-learning research queue's write path from chat's side -
    fire-and-forget whenever the Coordinator's knowledgeGapTopic is
    non-null. Dedup/already-known/queue-depth gating all happen inside
    knowledge-engine's own enqueueTopic - this is a thin, fail-silent client.
    """
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{config.knowledge_engine_url}/research-queue",
                json={"topic": topic, "domain": domain, "originSessionId": session_id, "triggerSource": "chat"},
                timeout=10,
            )
    except Exception:
        logger.exception("knowledge-engine research-queue enqueue failed")


@dataclass(frozen=True)
class OpenProjectSummary:
    id: int
    title: str
    status: str


# Caps how many open projects get injected into the system prompt every
# turn - short, always-on list, not exhaustive.
_MAX_OPEN_PROJECTS_IN_PROMPT = 10


async def list_open_projects(config: Config) -> list[OpenProjectSummary]:
    """Powers the always-on 'already proposed or active projects' line in
    system_prompt.py - lets the model recognize an already-covered idea
    before ever calling project_propose, rather than relying solely on
    knowledge-engine's own title-lexeme-overlap dedup check after the fact."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{config.knowledge_engine_url}/projects", timeout=8)
            if not res.is_success:
                return []
            projects = res.json().get("projects") or []
            open_projects = [p for p in projects if p.get("status") in ("proposed", "active")]
            return [
                OpenProjectSummary(id=p["id"], title=p["title"], status=p["status"])
                for p in open_projects[:_MAX_OPEN_PROJECTS_IN_PROMPT]
            ]
    except Exception:
        logger.exception("list_open_projects failed")
        return []
