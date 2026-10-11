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

from . import growth_consolidate, growth_db, growth_teaching
from .config import Config

_JSON_FIELDS = (
    "evidence", "raw_judge_output", "detail", "baseline_definition", "candidate_definition",
    "baseline_results", "candidate_results", "baseline_scores", "candidate_scores", "steps",
    "expected_attribution", "expected_min_scores", "turn_ids", "tool_calls",
    "user_card_snapshot", "user_card_for_amy_snapshot", "preview_evaluation",
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

    @router.post("/opportunities/{opportunity_id}/dismiss")
    async def dismiss_opportunity(opportunity_id: int):
        await growth_db.set_opportunity_status(config, opportunity_id, "rejected")
        return {"ok": True, "opportunityId": opportunity_id, "status": "rejected"}

    @router.post("/opportunities/{opportunity_id}/defer")
    async def defer_opportunity(opportunity_id: int):
        await growth_db.set_opportunity_status(config, opportunity_id, "dormant")
        return {"ok": True, "opportunityId": opportunity_id, "status": "dormant"}

    @router.post("/opportunities/{opportunity_id}/promote")
    async def promote_opportunity(opportunity_id: int):
        proposal_id = await growth_db.promote_opportunity_to_proposal(config, opportunity_id)
        if proposal_id is None:
            return {"ok": False, "error": "opportunity not found or already proposed/rejected/dormant"}
        return {"ok": True, "opportunityId": opportunity_id, "proposalId": proposal_id}

    @router.get("/learning-plans")
    async def list_learning_plans(status: str | None = None, limit: int = 50):
        rows = await growth_db.list_learning_plans(config, status=status, limit=limit)
        return {"learningPlans": [_clean_row(r) for r in rows]}

    @router.get("/experiments")
    async def list_experiments(limit: int = 50):
        rows = await growth_db.list_experiments(config, limit=limit)
        return {"experiments": [_clean_row(r) for r in rows]}

    @router.get("/history")
    async def list_history(limit: int = 100):
        rows = await growth_db.list_growth_history(config, limit=limit)
        return {"history": [_clean_row(r) for r in rows]}

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

    @router.post("/proposals/{proposal_id}/preview")
    async def preview_proposal(proposal_id: int):
        preview = await growth_consolidate.preview_proposal(config, proposal_id)
        return _clean_row(preview) if isinstance(preview, dict) else preview

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

    @router.get("/persona-proposal")
    async def get_persona_proposal(name: str = "Amy"):
        row = await growth_db.get_persona_proposal(config, name)
        if not row:
            return {"pending": False}
        diff = growth_consolidate.unified_diff(row.get("system_prompt") or "", row.get("proposed_system_prompt") or "")
        return {"pending": True, "diff": diff, **_clean_row(row)}

    @router.post("/persona-proposal/promote")
    async def promote_persona_proposal(body: dict | None = None):
        name = (body or {}).get("name") or "Amy"
        result = await growth_db.promote_persona_proposal(config, name)
        return {**result, "name": name}

    @router.post("/persona-proposal/dismiss")
    async def dismiss_persona_proposal(body: dict | None = None):
        name = (body or {}).get("name") or "Amy"
        reason = (body or {}).get("reason")
        result = await growth_db.dismiss_persona_proposal(config, name, reason)
        return {**result, "name": name}

    @router.post("/teaching-sessions")
    async def start_teaching_session(body: dict):
        mode = body.get("mode")
        if mode not in ("demonstration", "guided_practice", "explain_and_build"):
            return {"ok": False, "error": "mode must be one of demonstration/guided_practice/explain_and_build"}
        session_id = body.get("sessionId")
        content = body.get("content") or ""
        teaching_session_id = await growth_db.create_teaching_session(config, mode, session_id, content)
        return {"ok": True, "teachingSessionId": teaching_session_id}

    @router.post("/teaching-sessions/{teaching_session_id}/capture")
    async def capture_teaching_content(teaching_session_id: int, body: dict):
        content = body.get("content")
        if not content:
            return {"ok": False, "error": "content is required"}
        await growth_db.append_teaching_content(config, teaching_session_id, content)
        return {"ok": True, "teachingSessionId": teaching_session_id}

    @router.post("/teaching-sessions/{teaching_session_id}/finalize")
    async def finalize_teaching_session(teaching_session_id: int):
        result = await growth_teaching.finalize_teaching_session(config, teaching_session_id)
        return _clean_row(result) if isinstance(result, dict) else result

    @router.get("/teaching-sessions")
    async def list_teaching_sessions(status: str | None = None, limit: int = 50):
        rows = await growth_db.list_teaching_sessions(config, status=status, limit=limit)
        return {"teachingSessions": [_clean_row(r) for r in rows]}

    @router.get("/teaching-sessions/{teaching_session_id}")
    async def get_teaching_session(teaching_session_id: int):
        row = await growth_db.get_teaching_session(config, teaching_session_id)
        if not row:
            return {"error": "not found"}
        return _clean_row(row)

    return router
