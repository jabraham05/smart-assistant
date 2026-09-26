"""Direct port of chat-orchestrator/src/session-memory.ts - replaces n8n's
Postgres Chat Memory node for chat specifically. REDIS_DB (0 prod / 1 test)
keeps the two running instances' session buffers from ever colliding.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import redis.asyncio as redis
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart

from .config import Config

_MAX_TURNS = 15
# 30 days of silence on a session is long past any real "resume this
# conversation" window - matches n8n's Postgres Chat Memory table having no
# TTL of its own in practice (sessions are long-lived) while staying bounded.
_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

_client: redis.Redis | None = None


def _get_client(config: Config) -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis(host=config.redis.host, port=config.redis.port, db=config.redis.db)
    return _client


def _key(session_id: str) -> str:
    return f"agent-service:session:{session_id}"


def _honcho_init_key(session_id: str) -> str:
    return f"agent-service:honcho-init:{session_id}"


async def is_honcho_initialized(config: Config, session_id: str) -> bool:
    """Real, live-verified finding: ensure_session_exists/set_user_observe_
    config were being re-sent to Honcho's cloud API on EVERY single turn
    with memory_policy != 'none', even though both are idempotent one-time
    session setup - a real, measured ~1-2s of external network round-trips
    paid again on every turn for no benefit after the first. This flag lets
    the caller skip both after the first time for a given session."""
    client = _get_client(config)
    return bool(await client.exists(_honcho_init_key(session_id)))


async def mark_honcho_initialized(config: Config, session_id: str) -> None:
    client = _get_client(config)
    await client.set(_honcho_init_key(session_id), "1", ex=_SESSION_TTL_SECONDS)


@dataclass(frozen=True)
class StoredTurn:
    user: str
    amy: str


@dataclass(frozen=True)
class HistoryMessage:
    role: str  # "user" | "assistant"
    content: str


async def append_turn(config: Config, session_id: str, user_message: str, amy_message: str) -> None:
    client = _get_client(config)
    turn = json.dumps({"user": user_message, "amy": amy_message})
    key = _key(session_id)
    await client.rpush(key, turn)
    await client.ltrim(key, -_MAX_TURNS, -1)
    await client.expire(key, _SESSION_TTL_SECONDS)


async def get_recent_history(config: Config, session_id: str) -> list[HistoryMessage]:
    client = _get_client(config)
    raw = await client.lrange(_key(session_id), 0, -1)

    messages: list[HistoryMessage] = []
    for item in raw:
        try:
            turn = json.loads(item)
        except (json.JSONDecodeError, TypeError):
            continue
        messages.append(HistoryMessage(role="user", content=turn["user"]))
        messages.append(HistoryMessage(role="assistant", content=turn["amy"]))
    return messages


def to_model_messages(history: list[HistoryMessage]) -> list[ModelMessage]:
    """Real, live-verified finding: get_recent_history's result used to feed
    only a 1-turn "recent_context" string into the tool classifier - the
    actual reply-generating Agent never received message_history at all, so
    every turn was stateless from the model's own perspective (continuity
    depended entirely on system-prompt injection: Honcho cards, memory-engine
    search, open tasks/goals/projects - none of which is "what did we just
    say"). Confirmed live: a fact stated two messages earlier in the same
    Discord session was completely forgotten. PydanticAI's message_history
    takes ModelRequest (user turn, UserPromptPart) / ModelResponse (assistant
    turn, TextPart) objects directly - no builder utility exists in the
    package for this, this is the documented manual-construction pattern.
    Deliberately excludes SystemPromptPart: the current turn's system prompt
    is already applied fresh via Agent(instructions=...) at construction
    time, so duplicating it here would only make it stale."""
    result: list[ModelMessage] = []
    for m in history:
        if m.role == "user":
            result.append(ModelRequest(parts=[UserPromptPart(m.content)]))
        else:
            result.append(ModelResponse(parts=[TextPart(m.content)]))
    return result
