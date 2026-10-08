"""Growth engine Phase 6.5: consolidation. Once a proposal is approved
(growth_db.set_proposal_status 'approved', via the growth_review MCP tool
or the HTTP routes in growth_routes.py), this decides where the
improvement actually lands - the missing bridge the roadmap calls out
between Growth's own bookkeeping and the systems that already exist:

    Learning
       |
    +--+------------+------------+
    |               |            |
 Knowledge        Skill       Behavior
    |               |            |
 entities        skills     persona proposal
(research DB)  (n8n Data    (personas.proposed_*,
               Table)       still human-promoted)

'tool' category proposals route into the existing skill_proposals
human-review queue instead, since building a new tool/integration is
real engineering work no amount of Growth automation can do on its own.
"""

from __future__ import annotations

import logging

from . import db, growth_db, growth_judge, knowledge_client
from .config import Config

logger = logging.getLogger(__name__)


async def consolidate_proposal(config: Config, proposal_id: int) -> dict:
    proposal = await growth_db.get_proposal(config, proposal_id)
    if not proposal:
        return {"ok": False, "error": "proposal not found"}
    if proposal["status"] != "approved":
        return {"ok": False, "error": f"proposal status is '{proposal['status']}', not 'approved'"}

    category = proposal["category"]
    title = proposal["opportunity_title"]
    description = proposal["opportunity_description"]
    rationale = proposal["rationale"]
    result: dict = {"ok": True, "category": category}

    try:
        if category == "knowledge":
            await knowledge_client.create_entity_from_chat(config, "learning", f"{title}: {description}")
            result["destination"] = "entities (research DB, type=learning)"

        elif category == "skill":
            instructions = (
                f"{description}\n\nRationale: {rationale}\n\n"
                "(Drafted automatically by the Growth engine from an approved proposal - "
                "review and refine before relying on it heavily.)"
            )
            await growth_db.consolidate_skill(config, title[:100], description[:500], instructions, rationale)
            result["destination"] = "skills (active instruction skill)"

        elif category == "tool":
            await growth_db.create_tool_idea_proposal(config, title[:100], description[:500], rationale, description)
            result["destination"] = "skill_proposals (kind=tool_idea, pending human review)"

        else:  # behavior -> persona edit, gated by a golden-transcript regression check
            current_persona = await db.get_persona_system_prompt(config) or ""
            candidate_persona = (
                f"{current_persona}\n\n"
                f"<!-- Growth engine proposal #{proposal_id}: {title} -->\n{description}"
            )
            regression = await growth_judge.check_golden_regression(config, current_persona, candidate_persona)
            regressed_any = any(r["regressed"] for r in regression)

            experiment_id = await growth_db.create_experiment(
                config,
                f"Golden-transcript regression check for proposal #{proposal_id}",
                {"persona": "current"},
                {"persona": "candidate", "description": description},
                proposal_id=proposal_id,
            )
            if experiment_id:
                await growth_db.record_evaluation(
                    config,
                    experiment_id,
                    "golden_regression",
                    baseline_score=None,
                    candidate_score=None,
                    baseline_results={"transcripts": regression},
                    candidate_results={},
                    notes=f"regressed={regressed_any}",
                    improved=not regressed_any,
                )

            note = f"⚠️ REGRESSION on golden transcripts: {rationale}" if regressed_any else rationale
            await growth_db.propose_persona_edit(config, "Amy", candidate_persona, note)
            result["destination"] = "personas.proposed_system_prompt (still requires manual promotion)"
            result["regression"] = regression
            result["regressed_any"] = regressed_any

        await growth_db.insert_growth_history(
            config, "consolidated", {"destination": result.get("destination")}, proposal_id=proposal_id
        )
        return result
    except Exception:
        logger.exception("growth_consolidate.consolidate_proposal failed for proposal %s", proposal_id)
        return {"ok": False, "error": "consolidation failed, see logs"}
