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
import difflib
import json
import logging
from datetime import datetime, timezone

from . import db, growth_db, growth_graphiti, growth_judge, knowledge_client, skills_library
from .config import Config

logger = logging.getLogger(__name__)


def _draft_skill_instructions(description: str, rationale: str) -> str:
    return (
        f"{description}\n\nRationale: {rationale}\n\n"
        "(Drafted automatically by the Growth engine from an approved proposal - "
        "review and refine before relying on it heavily.)"
    )


async def _build_skill_draft(config: Config, opportunity_id: int, description: str, rationale: str) -> str:
    """A teaching-sourced skill proposal already has a judge-extracted
    procedure/rules/examples (growth_judge.classify_teaching_content) - use
    that structured extraction instead of falling back to the raw captured
    text + generic boilerplate every other skill proposal uses. Found live
    while testing Phase 10: without this, a teaching session's nicely
    parsed steps got discarded in favor of dumping the whole paragraph back
    out, making the "drafted automatically" skill look no better than one
    sourced from an ordinary recurring-failure signal."""
    session = await growth_db.get_teaching_session_by_opportunity(config, opportunity_id)
    if not session or not session.get("extracted_procedure"):
        return _draft_skill_instructions(description, rationale)

    parts = [f"Procedure:\n{session['extracted_procedure']}"]
    if session.get("extracted_rules"):
        parts.append(f"Rules:\n{session['extracted_rules']}")
    if session.get("extracted_examples"):
        parts.append(f"Examples:\n{session['extracted_examples']}")
    parts.append(
        "(Drafted from a teaching session - review and refine before relying on it heavily.)"
    )
    return "\n\n".join(parts)


async def _build_skill_metadata(config: Config, opportunity_id: int, title: str, description: str) -> tuple[str, str]:
    """A skill's name/description now have to satisfy the Agent Skills
    spec (https://agentskills.io/specification) - kebab-case name, a real
    discovery description ("what it does + when to use it") - not the raw
    truncated opportunity title/description every skill used to get stuck
    with (we found this live: the stored name for one was literally "Thats
    a decent start, but here is the rule..."). A teaching-sourced proposal
    already has a judge-generated skillName/discoveryDescription
    (growth_judge.classify_teaching_content); anything else (skill_gap_scan,
    behaviorFeedback) falls back to slugifying the opportunity title - not
    as good, but still spec-valid, which raw prose never was."""
    session = await growth_db.get_teaching_session_by_opportunity(config, opportunity_id)
    if session and session.get("skill_name"):
        return session["skill_name"], session.get("discovery_description") or description[:500]
    return skills_library.slugify(title), description[:500]


def _build_candidate_persona(current_persona: str, proposal_id: int, title: str, description: str) -> str:
    return (
        f"{current_persona}\n\n"
        f"<!-- Growth engine proposal #{proposal_id}: {title} -->\n{description}"
    )


def unified_diff(current_text: str, proposed_text: str) -> list[str]:
    return list(
        difflib.unified_diff(
            current_text.splitlines(),
            proposed_text.splitlines(),
            fromfile="current",
            tofile="proposed",
            lineterm="",
        )
    )


async def preview_proposal(config: Config, proposal_id: int) -> dict:
    """What the Review Queue calls before a human decides - computes the
    real candidate text (and, for skill/behavior, runs the same before/after
    check consolidate_proposal() would run after approval) without writing
    anything to skills/personas/entities. Persists the result so approval
    reuses exactly what was previewed instead of generating a second,
    possibly different candidate."""
    proposal = await growth_db.get_proposal(config, proposal_id)
    if not proposal:
        return {"ok": False, "error": "proposal not found"}

    category = proposal["category"]
    title = proposal["opportunity_title"]
    description = proposal["opportunity_description"]
    rationale = proposal["rationale"]
    opportunity_id = proposal["opportunity_id"]
    observations = await growth_db.list_observations_for_opportunity(config, opportunity_id)
    result: dict = {
        "ok": True,
        "category": category,
        "observations": [{"summary": o["summary"], "source": o["source"]} for o in observations],
        "opportunity": {
            "confidence": proposal.get("opportunity_confidence"),
            "score": proposal.get("opportunity_score"),
            "frequency": proposal.get("opportunity_frequency"),
        },
    }

    if category == "skill":
        skill_name, skill_description = await _build_skill_metadata(config, opportunity_id, title, description)
        draft_instructions = await _build_skill_draft(config, opportunity_id, description, rationale)
        evidence_text = "\n".join(f"- {o['summary']}" for o in observations) or description
        evaluation = await growth_judge.evaluate_skill_plausibility(config, evidence_text, draft_instructions)
        evaluation_dict = (
            {"effectivenessScore": evaluation.effectiveness_score, "reasoning": evaluation.reasoning}
            if evaluation
            else None
        )
        result["skillName"] = skill_name
        result["skillDescription"] = skill_description
        result["currentText"] = ""
        result["proposedText"] = draft_instructions
        result["diff"] = unified_diff("", draft_instructions)
        result["evaluation"] = evaluation_dict
        await growth_db.save_proposal_preview(config, proposal_id, "", draft_instructions, evaluation_dict)

    elif category == "behavior":
        current_persona = await db.get_persona_system_prompt(config) or ""
        candidate_persona = _build_candidate_persona(current_persona, proposal_id, title, description)
        regression = await growth_judge.check_golden_regression(config, current_persona, candidate_persona)
        regressed_any = any(r["regressed"] for r in regression)
        evaluation_dict = {"regression": regression, "regressedAny": regressed_any}
        result["currentText"] = current_persona
        result["proposedText"] = candidate_persona
        result["diff"] = unified_diff(current_persona, candidate_persona)
        result["evaluation"] = evaluation_dict
        await growth_db.save_proposal_preview(config, proposal_id, current_persona, candidate_persona, evaluation_dict)

    else:
        # knowledge / tool: the "candidate" is just the proposal's own
        # description - there's no separately generated text to diff.
        result["currentText"] = ""
        result["proposedText"] = description
        result["diff"] = []
        result["evaluation"] = None

    return result


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
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 0, "completed")

            # Reuse a prior preview_proposal() run so the human approved
            # exactly this text, instead of regenerating (and potentially
            # drifting from) it now.
            cached_text = proposal.get("proposed_text")
            cached_eval_raw = proposal.get("preview_evaluation")
            cached_eval = (
                json.loads(cached_eval_raw) if isinstance(cached_eval_raw, str) else cached_eval_raw
            ) or {}
            if cached_text:
                draft_instructions = cached_text
                eval_effectiveness = cached_eval.get("effectivenessScore")
                eval_reasoning = cached_eval.get("reasoning")
            else:
                draft_instructions = await _build_skill_draft(config, opportunity_id, description, rationale)
                observations = await growth_db.list_observations_for_opportunity(config, opportunity_id)
                evidence_text = "\n".join(f"- {o['summary']}" for o in observations) or description
                evaluation = await growth_judge.evaluate_skill_plausibility(config, evidence_text, draft_instructions)
                eval_effectiveness = evaluation.effectiveness_score if evaluation else None
                eval_reasoning = evaluation.reasoning if evaluation else None

            experiment_id = await growth_db.create_experiment(
                config,
                f"Skill plausibility evaluation for proposal #{proposal_id}",
                {"opportunityId": opportunity_id},
                {"draftInstructions": draft_instructions},
                proposal_id=proposal_id,
            )
            passed = eval_effectiveness is not None and eval_effectiveness >= growth_judge.SKILL_EFFECTIVENESS_PASS_THRESHOLD
            if experiment_id:
                await growth_db.record_evaluation(
                    config,
                    experiment_id,
                    "skill_plausibility",
                    baseline_score=None,
                    candidate_score=float(eval_effectiveness) if eval_effectiveness is not None else None,
                    baseline_results={},
                    candidate_results={"reasoning": eval_reasoning},
                    notes=f"passed={passed}",
                    improved=passed,
                )
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 1, "completed" if eval_effectiveness is not None else "failed")

            reason = rationale
            if not passed:
                eval_note = eval_reasoning or "evaluation could not be run"
                reason = f"⚠️ LOW-CONFIDENCE evaluation ({eval_note}): {rationale}"

            skill_name, skill_description = await _build_skill_metadata(config, opportunity_id, title, description)
            skills_library.write_skill(
                config,
                skill_name,
                skill_description,
                draft_instructions,
                {
                    "source": "growth_engine",
                    "proposalId": str(proposal_id),
                    "opportunityId": str(opportunity_id),
                    "consolidatedAt": datetime.now(timezone.utc).isoformat(),
                },
            )
            await growth_db.consolidate_skill(config, skill_name, skill_description, draft_instructions, reason)
            if plan_id:
                await growth_db.advance_learning_plan_step(config, plan_id, 2, "completed")
            result["destination"] = "skills (active instruction skill)"
            result["skillName"] = skill_name
            result["evaluation"] = {"effectivenessScore": eval_effectiveness, "passed": passed}

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

            cached_text = proposal.get("proposed_text")
            cached_eval_raw = proposal.get("preview_evaluation")
            cached_eval = (
                json.loads(cached_eval_raw) if isinstance(cached_eval_raw, str) else cached_eval_raw
            ) or {}
            if cached_text:
                candidate_persona = cached_text
                regression = cached_eval.get("regression", [])
                regressed_any = cached_eval.get("regressedAny", any(r["regressed"] for r in regression))
            else:
                current_persona = await db.get_persona_system_prompt(config) or ""
                candidate_persona = _build_candidate_persona(current_persona, proposal_id, title, description)
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
