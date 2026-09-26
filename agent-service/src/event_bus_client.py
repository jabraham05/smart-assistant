"""Direct port of chat-orchestrator/src/event-bus-client.ts."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from .config import Config

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TaskContextSummary:
    id: int
    objective: str
    status: str


@dataclass(frozen=True)
class GoalSummary:
    id: int
    title: str
    status: str


async def match_task_contexts(config: Config, text: str) -> list[TaskContextSummary]:
    """Which open task contexts does this message's text actually relate to,
    via event-bus's lexeme-overlap matcher. Real bug found via live
    dogfooding: task contexts used to be injected into every turn
    unconditionally, letting a single standing reminder bleed into
    unrelated conversations - this scopes injection to genuine relevance."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{config.event_bus_url}/task-contexts/match", params={"text": text}, timeout=10)
            if not res.is_success:
                return []
            items = res.json().get("taskContexts") or []
            return [TaskContextSummary(id=i["id"], objective=i["objective"], status=i["status"]) for i in items]
    except Exception:
        logger.exception("match_task_contexts failed")
        return []


async def match_goals(config: Config, text: str) -> list[GoalSummary]:
    """Which active goals does this message's text match, via event-bus's
    deterministic keyword matcher - no LLM call, self-limiting to
    genuinely relevant goals rather than every open goal every turn."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{config.event_bus_url}/goals/match", params={"text": text}, timeout=10)
            if not res.is_success:
                return []
            items = res.json().get("goals") or []
            return [GoalSummary(id=i["id"], title=i["title"], status=i["status"]) for i in items]
    except Exception:
        logger.exception("match_goals failed")
        return []


async def publish_behavior_feedback(config: Config, session_id: str, category: str, note: str) -> None:
    """Direct port of chat-orchestrator's publishBehaviorFeedbackEvent - the
    live backend (agent-service) computed this signal every turn but never
    persisted it (confirmed via grep this session), meaning zero real
    behavior-feedback data was being captured from production traffic.
    Fire-and-forget, same swallow-and-log pattern as match_task_contexts/
    match_goals above - a slow/unreachable event-bus must never affect the
    actual chat turn."""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{config.event_bus_url}/events",
                json={
                    "source": "agent_service",
                    "type": "behavior_feedback",
                    "payload": {"category": category, "note": note},
                    "originSessionId": session_id,
                },
                timeout=10,
            )
    except Exception:
        logger.exception("publish_behavior_feedback failed")
