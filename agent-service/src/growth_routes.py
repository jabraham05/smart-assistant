"""HTTP surface for the Growth engine's human-approval step (Phase 6.5).
Mounted into agent-service's existing FastAPI app (see main.py) rather
than a new service - Growth lives inside agent-service per the roadmap.

skills-mcp's growth_review tool is the intended caller (same "MCP tool
proxies to the owning service's HTTP API" pattern task_context_manage
already uses for event-bus), so a user can list/approve/reject Growth
proposals conversationally, the same way skill proposals and task
contexts are already reviewed - no new chat-ui page needed for this.
"""

from __future__ import annotations

import json
from decimal import Decimal

from fastapi import APIRouter

from . import growth_consolidate, growth_db
from .config import Config

_JSON_FIELDS = (
    "evidence", "raw_judge_output", "detail", "baseline_definition", "candidate_definition",
    "baseline_results", "candidate_results", "baseline_scores", "candidate_scores", "steps",
    "expected_attribution", "expected_min_scores", "turn_ids", "tool_calls",
    "user_card_snapshot", "user_card_for_amy_snapshot",
)


def _jsonify(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: _jsonify(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonify(v) for v in value]
    return value


def _clean_row(row: dict) -> dict:
    out = {}
    for key, value in row.items():
        if key in _JSON_FIELDS and isinstance(value, str):
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                pass
        out[key] = _jsonify(value)
    return out


def build_router(config: Config) -> APIRouter:
    router = APIRouter(prefix="/growth")

    @router.get("/opportunities")
    async def list_opportunities(status: str | None = None, limit: int = 50):
        rows = await growth_db.list_opportunities(config, status=status, limit=limit)
        return {"opportunities": [_clean_row(r) for r in rows]}

    @router.get("/proposals")
    async def list_proposals(status: str | None = None, limit: int = 50):
        rows = await growth_db.list_proposals(config, status=status, limit=limit)
        return {"proposals": [_clean_row(r) for r in rows]}

    @router.get("/proposals/{proposal_id}")
    async def get_proposal(proposal_id: int):
        row = await growth_db.get_proposal(config, proposal_id)
        if not row:
            return {"error": "not found"}
        return _clean_row(row)

    @router.post("/proposals/{proposal_id}/approve")
    async def approve_proposal(proposal_id: int, body: dict | None = None):
        notes = (body or {}).get("notes")
        await growth_db.set_proposal_status(config, proposal_id, "approved", notes)
        consolidation = await growth_consolidate.consolidate_proposal(config, proposal_id)
        return {"ok": True, "proposalId": proposal_id, "status": "approved", "consolidation": _jsonify(consolidation)}

    @router.post("/proposals/{proposal_id}/reject")
    async def reject_proposal(proposal_id: int, body: dict | None = None):
        notes = (body or {}).get("notes")
        await growth_db.set_proposal_status(config, proposal_id, "rejected", notes)
        return {"ok": True, "proposalId": proposal_id, "status": "rejected"}

    return router
