"""Growth engine Phase 6.5 (+ follow-up gap fixes): consolidation. Once a
proposal is approved (growth_db.set_proposal_status 'approved', via the
growth_review MCP tool or the HTTP routes in growth_routes.py), this
decides where the improvement actually lands - the missing bridge the
roadmap calls out between Growth's own bookkeeping and the systems that
already exist:

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

Every category now runs through a real Learning Plan (roadmap: Proposal ->
Learning Plan -> Experiment -> Evaluation -> Consolidation), and 'skill'
proposals get a real before/after check (a judge-based plausibility
evaluation against the opportunity's own evidence) before being written -
previously only 'behavior' proposals had this via golden-transcript
regression; 'skill' proposals used to skip straight from approval to
writing the skill with no evaluation step at all."""

from __future__ import annotations

import asyncio
import logging

from . import db, growth_db, growth_graphiti, growth_judge, knowledge_client
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
    opportunity_id = proposal["opportunity_id"]
    result: dict = {"ok": True, "category": category}

    plan_id = await growth_db.create_learning_plan(config, proposal_id, category)

    try:
        if category == "knowledge":
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 0, "completed")
            await knowledge_client.create_entity_from_chat(config, "learning", f"{title}: {description}")
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 1, "completed")
            result["destination"] = "entities (research DB, type=learning)"

        elif category == "skill":
            draft_instructions = (
                f"{description}\n\nRationale: {rationale}\n\n"
                "(Drafted automatically by the Growth engine from an approved proposal - "
                "review and refine before relying on it heavily.)"
            )
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 0, "completed")

            observations = await growth_db.list_observations_for_opportunity(config, opportunity_id)
            evidence_text = "\n".join(f"- {o['summary']}" for o in observations) or description
            evaluation = await growth_judge.evaluate_skill_plausibility(config, evidence_text, draft_instructions)

            experiment_id = await growth_db.create_experiment(
                config,
                f"Skill plausibility evaluation for proposal #{proposal_id}",
                {"evidence": evidence_text},
                {"draftInstructions": draft_instructions},
                proposal_id=proposal_id,
            )
            passed = evaluation is not None and evaluation.effectiveness_score >= growth_judge.SKILL_EFFECTIVENESS_PASS_THRESHOLD
            if experiment_id:
                await growth_db.record_evaluation(
                    config,
                    experiment_id,
                    "skill_plausibility",
                    baseline_score=None,
                    candidate_score=float(evaluation.effectiveness_score) if evaluation else None,
                    baseline_results={},
                    candidate_results={"reasoning": evaluation.reasoning if evaluation else None},
                    notes=f"passed={passed}",
                    improved=passed,
                )
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 1, "completed" if evaluation else "failed")

            reason = rationale
            if not passed:
                eval_note = evaluation.reasoning if evaluation else "evaluation could not be run"
                reason = f"⚠️ LOW-CONFIDENCE evaluation ({eval_note}): {rationale}"
            await growth_db.consolidate_skill(config, title[:100], description[:500], draft_instructions, reason)
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 2, "completed")
            result["destination"] = "skills (active instruction skill)"
            result["evaluation"] = {
                "effectivenessScore": evaluation.effectiveness_score if evaluation else None,
                "passed": passed,
            }

        elif category == "tool":
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 0, "completed")
            await growth_db.create_tool_idea_proposal(config, title[:100], description[:500], rationale, description)
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 1, "completed")
            result["destination"] = "skill_proposals (kind=tool_idea, pending human review)"

        else:  # behavior -> persona edit, gated by a golden-transcript regression check
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 0, "completed")
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
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 1, "completed")

            note = f"⚠️ REGRESSION on golden transcripts: {rationale}" if regressed_any else rationale
            await growth_db.propose_persona_edit(config, "Amy", candidate_persona, note)
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 2, "completed")
            result["destination"] = "personas.proposed_system_prompt (still requires manual promotion)"
            result["regression"] = regression
            result["regressed_any"] = regressed_any

        if plan_id:
            await growth_db.finish_learning_plan(config, plan_id, "complete")
        await growth_db.insert_growth_history(
            config, "consolidated", {"destination": result.get("destination")}, proposal_id=proposal_id
        )
        asyncio.create_task(
            growth_graphiti.add_episode(
                config,
                f"growth-consolidated-{proposal_id}",
                f"Amy consolidated a {category} improvement for \"{title}\" into {result.get('destination')}.",
                "growth_engine consolidated event",
            )
        )
        return result
    except Exception:
        logger.exception("growth_consolidate.consolidate_proposal failed for proposal %s", proposal_id)
        if plan_id:
            await growth_db.finish_learning_plan(config, plan_id, "abandoned")
        return {"ok": False, "error": "consolidation failed, see logs"}
