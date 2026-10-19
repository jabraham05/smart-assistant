"""Direct port of chat-orchestrator/src/honcho.ts - same workspace, same
endpoints, same payload shapes. Every function here swallows its own errors
and returns a safe fallback (same onError: continueRegularOutput behavior
the old n8n Chat workflow's Honcho HTTP Request nodes had) - a briefly
unreachable Honcho degrades the system prompt (missing peer cards) rather
than breaking the chat.
"""

from __future__ import annotations

import logging

import httpx

from .config import Config, is_test_session

logger = logging.getLogger(__name__)

_HONCHO_BASE_URL = "https://api.honcho.dev/v3"


def _auth_headers(config: Config) -> dict[str, str]:
    return {"Authorization": f"Bearer {config.honcho_api_key}", "Content-Type": "application/json"}


def _workspace_url(config: Config, path: str) -> str:
    return f"{_HONCHO_BASE_URL}/workspaces/{config.honcho_workspace_id}{path}"


async def ensure_session_exists(config: Config, session_id: str) -> None:
    if is_test_session(session_id):
        return
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                _workspace_url(config, "/sessions"), headers=_auth_headers(config), json={"id": session_id}
            )
    except Exception:
        logger.exception("honcho ensure_session_exists failed")


async def set_user_observe_config(config: Config, session_id: str) -> None:
    if is_test_session(session_id):
        return
    try:
        async with httpx.AsyncClient() as client:
            await client.put(
                _workspace_url(config, f"/sessions/{session_id}/peers/user/config"),
                headers=_auth_headers(config),
                json={"observe_others": True},
            )
    except Exception:
        logger.exception("honcho set_user_observe_config failed")


async def _get_peer_card(config: Config, path: str) -> list[str]:
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(_workspace_url(config, path), headers=_auth_headers(config))
            if not res.is_success:
                return []
            return res.json().get("peer_card") or []
    except Exception:
        logger.exception("honcho get_peer_card(%s) failed", path)
        return []


async def get_user_card(config: Config) -> list[str]:
    return await _get_peer_card(config, "/peers/user/card")


async def get_user_card_for_amy(config: Config) -> list[str]:
    return await _get_peer_card(config, "/peers/user/card?target=amy")


async def store_turn(config: Config, session_id: str, user_message: str, amy_message: str) -> None:
    if is_test_session(session_id):
        return
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                _workspace_url(config, f"/sessions/{session_id}/messages"),
                headers=_auth_headers(config),
                json={
                    "messages": [
                        {"content": user_message, "peer_id": "user"},
                        {"content": amy_message, "peer_id": "amy"},
                    ]
                },
            )
    except Exception:
        logger.exception("honcho store_turn failed")
