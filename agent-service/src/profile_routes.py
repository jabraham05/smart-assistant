"""Read-only profile surface powering chat-ui's Amy Lab "Profiles" tab.
Ported from chat-orchestrator/src/index.ts's GET /persona and GET
/user-profile (that service is retired - see docs/chat-orchestrator.md)
onto the exact same lookups buildAgent's own system-prompt assembly
already relies on (db.get_persona_system_prompt, honcho_client's peer-card
calls), so this always reflects the real live persona/profile, not a
snapshot. Mounted into agent-service's existing FastAPI app (see main.py),
same "HTTP surface alongside the webhook" pattern growth_routes.py uses.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import db, honcho_client
from .config import Config


def build_router(config: Config) -> APIRouter:
    router = APIRouter()

    @router.get("/persona")
    async def get_persona():
        system_prompt = await db.get_persona_system_prompt(config)
        return {"systemPrompt": system_prompt}

    @router.get("/user-profile")
    async def get_user_profile():
        user_card = await honcho_client.get_user_card(config)
        user_card_for_amy = await honcho_client.get_user_card_for_amy(config)
        return {"userCard": user_card, "userCardForAmy": user_card_for_amy}

    return router
