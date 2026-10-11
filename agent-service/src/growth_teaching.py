"""Growth engine Phase 10: Teaching layer (docs/unified-architecture-gap-
analysis.md §7/§11). One shared lifecycle for all three teaching modes -
demonstration, guided_practice, explain_and_build - that feeds the SAME
record_observation()/growth_proposals pipeline every other Growth signal
already uses, rather than a parallel learning system. The one new step
Teaching needs that nothing else does is classification: not every lesson
a user teaches should become a skill, so captured content is classified
(growth_judge.classify_teaching_content) into knowledge/skill/behavior/tool
BEFORE anything gets built - see Phase 10.3.

growth_db.py owns raw capture (create/append/get/list); this module owns
the one real piece of orchestration logic: finalize_teaching_session.
"""

from __future__ import annotations

import logging

from . import growth_db, growth_judge
from .config import Config

logger = logging.getLogger(__name__)


async def finalize_teaching_session(config: Config, teaching_session_id: int) -> dict:
    session = await growth_db.get_teaching_session(config, teaching_session_id)
    if not session:
        return {"ok": False, "error": "teaching session not found"}
    if session["status"] in ("routed", "consolidated"):
        return {"ok": False, "error": f"teaching session already {session['status']}"}

    classification = await growth_judge.classify_teaching_content(
        config, session["mode"], session["captured_content"]
    )
    if classification is None:
        return {"ok": False, "error": "classification failed, see logs"}

    await growth_db.set_teaching_session_classification(
        config,
        teaching_session_id,
        classification.category,
        classification.reasoning,
        classification.procedure,
        classification.rules,
        classification.examples,
        classification.open_questions,
    )

    # explain_and_build is a deliberate, complete lesson - exactly the kind
    # of single-occurrence evidence the high-confidence shortcut
    # (growth_db.PROPOSAL_HIGH_CONFIDENCE) exists for. demonstration/
    # guided_practice are genuine but less deliberately complete, so they
    # accumulate like any other observed signal (need a second occurrence).
    source = "teaching_session_explicit" if session["mode"] == "explain_and_build" else "teaching_session"

    opportunity_id = await growth_db.record_observation(
        config,
        source,
        session["captured_content"],
        {
            "mode": session["mode"],
            "teachingSessionId": teaching_session_id,
            "reasoning": classification.reasoning,
            "procedure": classification.procedure,
            "rules": classification.rules,
            "examples": classification.examples,
            "openQuestions": classification.open_questions,
        },
        session_id=session.get("session_id"),
        category=classification.category,
    )
    if opportunity_id is None:
        await growth_db.set_teaching_session_classification(
            config,
            teaching_session_id,
            classification.category,
            classification.reasoning,
            classification.procedure,
            classification.rules,
            classification.examples,
            classification.open_questions,
        )
        return {
            "ok": True,
            "category": classification.category,
            "status": "classified",
            "reasoning": classification.reasoning,
            "note": "Observation recording failed - classified but not yet routed, see logs.",
        }

    proposal = await growth_db.get_proposal_by_opportunity(config, opportunity_id)
    if proposal and proposal["status"] == "approved":
        status = "consolidated"  # Tier 1 (knowledge) auto-consolidates in the same call
    elif proposal:
        status = "routed"  # Tier 2 - sitting in growth_review, awaiting a human decision
    else:
        status = "classified"  # not enough evidence yet to clear the proposal threshold

    await growth_db.set_teaching_session_routing(
        config,
        teaching_session_id,
        status,
        opportunity_id=opportunity_id,
        proposal_id=proposal["id"] if proposal else None,
    )

    return {
        "ok": True,
        "category": classification.category,
        "status": status,
        "reasoning": classification.reasoning,
        "opportunityId": opportunity_id,
        "proposalId": proposal["id"] if proposal else None,
    }
