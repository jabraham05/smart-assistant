"""Growth engine Phase 8: Context Builder extraction - intentionally low
priority, and deliberately a pure relocation of already-working logic, not
a rewrite. Per the roadmap: "Do not rewrite working context assembly just
because the architecture diagram calls it Context Builder. You already
have it." This just names and extracts it, so Skill Discovery (Phase 7)
and any future Growth-engine context need have one clean integration
point, without disturbing the existing runtime.

Deliberately ONE module, not a context/ subpackage (builder.py/
retrieval.py/skill_discovery.py/assembly.py) - there isn't enough distinct
logic here yet to justify splitting further; that would be structure for
its own sake. Side effects that happen to be decided alongside this
(knowledgeGapTopic enqueue, behaviorFeedback publish, Growth observations,
memorable-item promotion) stay in main.py - they're consequences of
classification, not context the prompt itself needs, so they don't belong
in a function whose contract is "build me what this turn's prompt needs."
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import event_bus_client, growth_db, honcho_client, knowledge_client, memory_client, session_memory, skills_discovery
from .classify import GROUPS, ClassificationResult, classify_relevant_tools
from .config import Config
from .db import get_active_instruction_skills, get_persona_system_prompt
from .event_bus_client import GoalSummary, TaskContextSummary
from .knowledge_client import OpenProjectSummary
from .memory_client import MemorySearchResult
from .system_prompt import (
    OpenProject,
    OpenTask,
    OpenTeachingSession,
    RelevantGoal,
    RelevantMemory,
    SystemPromptInput,
    build_system_prompt,
)

logger = logging.getLogger(__name__)


@dataclass
class TurnContext:
    classification: ClassificationResult
    system_prompt: str
    should_acknowledge: bool
    persona_prompt: str | None
    open_tasks: list[TaskContextSummary]
    relevant_goals: list[GoalSummary]
    open_projects: list[OpenProjectSummary]
    relevant_memory_results: list[MemorySearchResult]
    user_card: list[str] = field(default_factory=list)
    user_card_for_amy: list[str] = field(default_factory=list)


async def build_context(
    config: Config, session_id: str, chat_input: str, recent_context: str | None
) -> TurnContext:
    _t = time.monotonic()
    (
        classification,
        persona_prompt,
        active_skills,
        skill_metadata,
        memory_results,
        open_tasks,
        relevant_goals,
        open_projects,
        open_teaching_session,
    ) = await asyncio.gather(
        classify_relevant_tools(config.ollama_host, config.classifier_model, chat_input, recent_context),
        get_persona_system_prompt(config),
        get_active_instruction_skills(config),
        skills_discovery.get_skill_metadata(config),
        memory_client.search_memory(config, chat_input),
        event_bus_client.match_task_contexts(config, chat_input),
        event_bus_client.match_goals(config, chat_input),
        knowledge_client.list_open_projects(config),
        growth_db.get_open_teaching_session(config, session_id),
    )
    # Real, live-verified finding (unchanged from before this extraction):
    # this gather's wall time is almost entirely classify_relevant_tools's
    # own LLM call - every other item here finishes in well under half a
    # second.
    logger.info("TIMING classify+context-gather session=%s took=%.2fs", session_id, time.monotonic() - _t)

    # Real gap found via live testing (2026-10-11): a teaching-session
    # continuation turn ("Also - if you find conflicting info...") has no
    # standing-instruction trigger phrase of its own, so neither the model
    # nor classify.py's own deterministic STANDING_INSTRUCTION_INTENT guard
    # recognized it as teaching - even though a session was already open
    # for this exact conversation. Fixed the same way open_tasks already
    # persists across turns: query real state, not re-detect it from text.
    # An open teaching session for this session_id always forces
    # self-growth/teaching_session_manage bound, full stop - no regex
    # needed once a session actually exists.
    if open_teaching_session and "self-growth" not in classification.relevant_groups:
        classification.relevant_groups.append("self-growth")
        classification.relevant_tools = list(
            dict.fromkeys([*classification.relevant_tools, *GROUPS["self-growth"]])
        )

    # 'web' deliberately does NOT solo-trigger this - see main.py's git
    # history for the live-verified reasoning (a bare web lookup is a
    # ~1-3s Tavily call, not background work).
    should_acknowledge = (
        classification.needs_planning
        or classification.background
        or "research" in classification.relevant_groups
        or "self-growth" in classification.relevant_groups
    )

    relevant_memory_results = (
        [
            m
            for m in memory_results
            if memory_client.is_relevant_memory(m, config.memory_min_relevance_score, config.memory_min_keyword_overlap)
        ]
        if classification.memory_policy != "none"
        else []
    )
    relevant_memories = [RelevantMemory(content=m.content, grounding=m.grounding) for m in relevant_memory_results]

    user_card: list[str] = []
    user_card_for_amy: list[str] = []
    if classification.memory_policy != "none":
        _t = time.monotonic()
        if not await session_memory.is_honcho_initialized(config, session_id):
            await honcho_client.ensure_session_exists(config, session_id)
            await honcho_client.set_user_observe_config(config, session_id)
            await session_memory.mark_honcho_initialized(config, session_id)
        user_card, user_card_for_amy = await asyncio.gather(
            honcho_client.get_user_card(config), honcho_client.get_user_card_for_amy(config)
        )
        logger.info("TIMING honcho session=%s took=%.2fs", session_id, time.monotonic() - _t)

    system_prompt = build_system_prompt(
        SystemPromptInput(
            persona_system_prompt=persona_prompt or "You are Amy, a helpful personal assistant.",
            now=datetime.now(timezone.utc),
            user_card=user_card,
            user_card_for_amy=user_card_for_amy,
            # Growth engine Phase 7: relevance-filtered, leveled loading
            # instead of every active skill unconditionally on every turn -
            # a skill with no skill_metadata row still always matches (see
            # skills_discovery._is_relevant), so this is a pure addition,
            # never a regression for an un-annotated skill.
            skills_catalog_text=skills_discovery.render_skills_catalog_text(
                skills_discovery.discover_relevant_skills(
                    active_skills, skill_metadata, chat_input, classification.relevant_groups
                ),
                skill_metadata,
            ),
            relevant_memories=relevant_memories,
            open_tasks=[OpenTask(id=t.id, objective=t.objective, status=t.status) for t in open_tasks],
            relevant_goals=[RelevantGoal(id=g.id, title=g.title, status=g.status) for g in relevant_goals],
            open_projects=[OpenProject(id=p.id, title=p.title, status=p.status) for p in open_projects],
            open_teaching_session=(
                OpenTeachingSession(
                    id=open_teaching_session["id"],
                    mode=open_teaching_session["mode"],
                    captured_preview=open_teaching_session["captured_content"][:200],
                )
                if open_teaching_session
                else None
            ),
            needs_planning_nudge=classification.needs_planning,
            narrate_before_slow_answer=should_acknowledge,
        )
    )

    return TurnContext(
        classification=classification,
        system_prompt=system_prompt,
        should_acknowledge=should_acknowledge,
        persona_prompt=persona_prompt,
        open_tasks=open_tasks,
        relevant_goals=relevant_goals,
        open_projects=open_projects,
        relevant_memory_results=relevant_memory_results,
        user_card=user_card,
        user_card_for_amy=user_card_for_amy,
    )
