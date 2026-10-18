"""Growth engine Phase 8: Context Builder extraction - intentionally low
priority, and deliberately a pure relocation of already-working logic, not
a rewrite. Per the roadmap: "Do not rewrite working context assembly just
because the architecture diagram calls it Context Builder. You already
have it." This just names and extracts it, so Skill Discovery (Phase 7)
and any future Growth-engine context need have one clean integration
point, without disturbing the existing runtime.

Two-phase now, not one `asyncio.gather` - respond.py's first-pass call needs
to see what's actually been retrieved (it can BE the final answer), so
retrieval has to finish before it runs. Phase 1 fetches everything in
parallel exactly as before (minus the response call itself, which moved
out); only if that response says `multi_turn` does Phase 2 run, refilling a
bigger context budget from the *same* already-ranked candidates - no second
retrieval, just a bigger slice of one ranked pool (context_budget.py).

Deliberately ONE module, not a context/ subpackage (builder.py/
retrieval.py/skill_discovery.py/assembly.py) - there isn't enough distinct
logic here yet to justify splitting further; that would be structure for
its own sake. Side effects that happen to be decided alongside this
(knowledgeGapTopic enqueue, behaviorFeedback publish, Growth observations,
memorable-item promotion, deferToGrowth) stay in main.py - they're
consequences of the turn output, not context the prompt itself needs, so
they don't belong in a function whose contract is "build me what this
turn's prompt needs."
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import context_budget, event_bus_client, growth_db, honcho_client, knowledge_client, memory_client, session_memory, skills_discovery
from .config import Config
from .db import get_active_instruction_skills, get_persona_system_prompt
from .event_bus_client import GoalSummary, TaskContextSummary
from .knowledge_client import KnowledgeSearchResult, OpenProjectSummary
from .memory_client import MemorySearchResult
from .respond import RESPOND_INSTRUCTIONS, TurnOutput, generate_response
from .system_prompt import (
    OpenProject,
    OpenTask,
    OpenTeachingSession,
    RelevantGoal,
    RelevantMemory,
    RelevantKnowledge,
    SystemPromptInput,
    build_system_prompt,
)

logger = logging.getLogger(__name__)


@dataclass
class TurnContext:
    turn_output: TurnOutput
    system_prompt: str
    persona_prompt: str | None
    open_tasks: list[TaskContextSummary]
    relevant_goals: list[GoalSummary]
    open_projects: list[OpenProjectSummary]
    relevant_memory_results: list[MemorySearchResult]
    relevant_knowledge_results: list[KnowledgeSearchResult]
    user_card: list[str] = field(default_factory=list)
    user_card_for_amy: list[str] = field(default_factory=list)


def _approx_memory_cost(m: MemorySearchResult) -> str:
    # A rough proxy for _format_memory_line's real rendered length, not a
    # byte-exact match - the budget is a heuristic, not a hard contract.
    return m.content


def _approx_knowledge_cost(k: KnowledgeSearchResult) -> str:
    return f"{k.document_title or k.source_title or ''}{' ' * 50}{k.content}"


def _approx_task_cost(t: TaskContextSummary) -> str:
    return f"{' ' * 20}{t.objective}"


def _approx_goal_cost(g: GoalSummary) -> str:
    return f"{' ' * 20}{g.title}"


def _select_pool(
    memory_results: list[MemorySearchResult],
    knowledge_results: list[KnowledgeSearchResult],
    open_tasks: list[TaskContextSummary],
    relevant_goals: list[GoalSummary],
    budget_chars: int,
) -> tuple[list[MemorySearchResult], list[KnowledgeSearchResult], list[TaskContextSummary], list[GoalSummary]]:
    """Pools memory/knowledge/task/goal candidates into one ranked list and
    greedily fills budget_chars from the top, instead of capping each
    category independently - see context_budget.py's module docstring for
    why independent per-category caps don't actually fix the dilution
    problem this exists to prevent."""
    memory_ranks = context_budget.rank_by_score(memory_results, lambda m: m.score)
    knowledge_ranks = context_budget.rank_by_score(knowledge_results, lambda k: k.score)
    task_ranks = context_budget.rank_by_position(open_tasks)
    goal_ranks = context_budget.rank_by_position(relevant_goals)

    candidates: list[tuple[str, int, float, str]] = [
        *(("memory", i, memory_ranks[i], _approx_memory_cost(m)) for i, m in enumerate(memory_results)),
        *(("knowledge", i, knowledge_ranks[i], _approx_knowledge_cost(k)) for i, k in enumerate(knowledge_results)),
        *(("task", i, task_ranks[i], _approx_task_cost(t)) for i, t in enumerate(open_tasks)),
        *(("goal", i, goal_ranks[i], _approx_goal_cost(g)) for i, g in enumerate(relevant_goals)),
    ]
    selected = context_budget.select_within_budget(candidates, budget_chars)
    return (
        [memory_results[i] for i in selected.get("memory", [])],
        [knowledge_results[i] for i in selected.get("knowledge", [])],
        [open_tasks[i] for i in selected.get("task", [])],
        [relevant_goals[i] for i in selected.get("goal", [])],
    )


def _build_prompt(
    *,
    persona_prompt: str | None,
    user_card: list[str],
    user_card_for_amy: list[str],
    skills_catalog_text: str,
    memory_results: list[MemorySearchResult],
    knowledge_results: list[KnowledgeSearchResult],
    open_tasks: list[TaskContextSummary],
    relevant_goals: list[GoalSummary],
    open_projects: list[OpenProjectSummary],
    open_teaching_session: dict | None,
    knowledge_strong_relevance_score: float,
    budget: str,
    planning_needed: bool,
) -> str:
    return build_system_prompt(
        SystemPromptInput(
            persona_system_prompt=persona_prompt or "You are Amy, a helpful personal assistant.",
            now=datetime.now(timezone.utc),
            user_card=user_card,
            user_card_for_amy=user_card_for_amy,
            skills_catalog_text=skills_catalog_text,
            relevant_memories=[RelevantMemory(content=m.content, grounding=m.grounding) for m in memory_results],
            relevant_knowledge=[
                RelevantKnowledge(
                    content=k.content,
                    document_title=k.document_title,
                    domain=k.domain,
                    score=k.score,
                    created_at=k.created_at,
                    retrieved_at=k.retrieved_at,
                    valid_until=k.valid_until,
                    source_url=k.source_url,
                    source_title=k.source_title,
                )
                for k in knowledge_results
            ],
            knowledge_strong_relevance_score=knowledge_strong_relevance_score,
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
            needs_planning_nudge=planning_needed,
            budget=budget,
            respond_instructions=RESPOND_INSTRUCTIONS if budget == "fast" else "",
        )
    )


async def build_context(
    config: Config, session_id: str, chat_input: str, recent_context: str | None
) -> TurnContext:
    _t = time.monotonic()
    (
        persona_prompt,
        active_skills,
        skill_metadata,
        memory_results,
        knowledge_results,
        open_tasks,
        relevant_goals,
        open_projects,
        open_teaching_session,
    ) = await asyncio.gather(
        get_persona_system_prompt(config),
        get_active_instruction_skills(config),
        skills_discovery.get_skill_metadata(config),
        memory_client.search_memory(config, chat_input),
        knowledge_client.search_knowledge(config, chat_input),
        event_bus_client.match_task_contexts(config, chat_input),
        event_bus_client.match_goals(config, chat_input),
        knowledge_client.list_open_projects(config),
        growth_db.get_open_teaching_session(config, session_id),
    )
    logger.debug("TIMING context-gather session=%s took=%.2fs", session_id, time.monotonic() - _t)

    relevant_memory_results = [
        m for m in memory_results
        if memory_client.is_relevant_memory(m, config.memory_min_relevance_score, config.memory_min_keyword_overlap)
    ]
    relevant_knowledge_results = [
        k for k in knowledge_results
        if knowledge_client.is_relevant_knowledge(
            k, config.knowledge_min_relevance_score, config.knowledge_min_keyword_overlap
        )
    ]

    user_card: list[str] = []
    user_card_for_amy: list[str] = []
    _t = time.monotonic()
    if not await session_memory.is_honcho_initialized(config, session_id):
        await honcho_client.ensure_session_exists(config, session_id)
        await honcho_client.set_user_observe_config(config, session_id)
        await session_memory.mark_honcho_initialized(config, session_id)
    user_card, user_card_for_amy = await asyncio.gather(
        honcho_client.get_user_card(config), honcho_client.get_user_card_for_amy(config)
    )
    logger.debug("TIMING honcho session=%s took=%.2fs", session_id, time.monotonic() - _t)

    # Growth engine Phase 7: relevance-filtered, leveled loading instead of
    # every active skill unconditionally on every turn - a skill with no
    # skill_metadata row still always matches (see
    # skills_discovery._is_relevant), so this is a pure addition, never a
    # regression for an un-annotated skill. Can't gate on relevant_groups
    # yet (that's the response call's own output) - uses chat_input alone,
    # same as every other Phase-1 retrieval call.
    skills_catalog_text = skills_discovery.render_skills_catalog_text(
        skills_discovery.discover_relevant_skills(active_skills, skill_metadata, chat_input, []),
        skill_metadata,
    )

    # Phase 1: fast-tier budget, pooled across every category - see
    # context_budget.py for why this is one ranked pool, not independent
    # per-category caps.
    fast_memories, fast_knowledge, fast_tasks, fast_goals = _select_pool(
        relevant_memory_results, relevant_knowledge_results, open_tasks, relevant_goals,
        context_budget.BUDGET_CHARS["fast"],
    )
    fast_prompt = _build_prompt(
        persona_prompt=persona_prompt, user_card=user_card, user_card_for_amy=user_card_for_amy,
        skills_catalog_text=skills_catalog_text, memory_results=fast_memories, knowledge_results=fast_knowledge,
        open_tasks=fast_tasks, relevant_goals=fast_goals, open_projects=open_projects,
        open_teaching_session=open_teaching_session, knowledge_strong_relevance_score=config.knowledge_strong_relevance_score,
        budget="fast", planning_needed=False,
    )

    turn_output = await generate_response(
        config.ollama_host, config.classifier_model, chat_input, fast_prompt, recent_context,
        open_teaching_session=bool(open_teaching_session),
    )

    system_prompt = fast_prompt
    if turn_output.multi_turn:
        # Phase 2: refill a bigger budget from the SAME already-fetched/
        # ranked candidates - no second retrieval, just a bigger slice of
        # one ranked pool.
        tier = "planning" if turn_output.planning_needed else "tool"
        tool_memories, tool_knowledge, tool_tasks, tool_goals = _select_pool(
            relevant_memory_results, relevant_knowledge_results, open_tasks, relevant_goals,
            context_budget.BUDGET_CHARS[tier],
        )
        system_prompt = _build_prompt(
            persona_prompt=persona_prompt, user_card=user_card, user_card_for_amy=user_card_for_amy,
            skills_catalog_text=skills_discovery.render_skills_catalog_text(
                skills_discovery.discover_relevant_skills(
                    active_skills, skill_metadata, chat_input, turn_output.relevant_groups
                ),
                skill_metadata,
            ),
            memory_results=tool_memories, knowledge_results=tool_knowledge, open_tasks=tool_tasks,
            relevant_goals=tool_goals, open_projects=open_projects, open_teaching_session=open_teaching_session,
            knowledge_strong_relevance_score=config.knowledge_strong_relevance_score,
            budget=tier, planning_needed=turn_output.planning_needed,
        )

    return TurnContext(
        turn_output=turn_output,
        system_prompt=system_prompt,
        persona_prompt=persona_prompt,
        open_tasks=open_tasks,
        relevant_goals=relevant_goals,
        open_projects=open_projects,
        relevant_memory_results=relevant_memory_results,
        relevant_knowledge_results=relevant_knowledge_results,
        user_card=user_card,
        user_card_for_amy=user_card_for_amy,
    )
