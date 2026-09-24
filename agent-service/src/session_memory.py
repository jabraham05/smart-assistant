"""Direct port of chat-orchestrator/src/session-memory.ts - replaces n8n's
Postgres Chat Memory node for chat specifically. REDIS_DB (0 prod / 1 test)
keeps the two running instances' session buffers from ever colliding.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import redis.asyncio as redis

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
