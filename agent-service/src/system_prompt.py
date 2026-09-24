"""Direct port of chat-orchestrator/src/system-prompt.ts's buildSystemPrompt -
same shape as the old n8n AI Agent.systemMessage expression: persona + date +
standing response-style/tool-error rules + user cards + relevant memories +
open tasks/goals/projects + planning/narrate nudges + skills catalog, each
clause degrading to nothing if its source is missing. Pure function, no I/O -
ported 1:1 including this session's own openProjects addition (see
docs/chat-orchestrator.md's dedupe-fix entry) so agent-service never regresses
behind chat-orchestrator's current behavior.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

_PACIFIC = ZoneInfo("America/Los_Angeles")


@dataclass(frozen=True)
class OpenTask:
    id: int
    objective: str
    status: str


@dataclass(frozen=True)
class RelevantGoal:
    id: int
    title: str
    status: str


@dataclass(frozen=True)
class OpenProject:
    id: int
    title: str
    status: str


@dataclass(frozen=True)
class SystemPromptInput:
    persona_system_prompt: str
    now: datetime
    user_card: list[str] = field(default_factory=list)
    user_card_for_amy: list[str] = field(default_factory=list)
    skills_catalog_text: str = ""
    # Pre-filtered by the caller based on memoryPolicy - this function stays
    # policy-agnostic: given something, render it; given nothing, omit the
    # section entirely.
    relevant_memories: list[str] | None = None
    # Injected regardless of memoryPolicy (directly actionable state, not
    # ambient personalization) but lexeme-matched to the current message by
    # the caller, not every open task every turn.
    open_tasks: list[OpenTask] | None = None
    relevant_goals: list[RelevantGoal] | None = None
    # Unlike open_tasks/relevant_goals, deliberately NOT relevance-filtered -
    # a short, capped list of every currently proposed/active project, shown
    # every turn regardless of topic, specifically to catch a re-proposal the
    # model wouldn't otherwise recognize as a duplicate.
    open_projects: list[OpenProject] | None = None
    needs_planning_nudge: bool = False
    narrate_before_slow_answer: bool = False


def _format_pacific(now: datetime) -> str:
    local = now.astimezone(_PACIFIC)
    # e.g. "Monday, September 21, 2026 at 2:30 PM" - built directly rather
    # than relying on locale-formatting quirks (the TS version normalizes
    # Intl's occasionally-inconsistent "at" wording; strftime here is
    # deterministic, so no equivalent normalization is needed).
    weekday_date = local.strftime("%A, %B ") + str(local.day) + local.strftime(", %Y")
    time_part = local.strftime("%I:%M %p").lstrip("0")
    return f"{weekday_date} at {time_part}"


def build_system_prompt(input: SystemPromptInput) -> str:
    date_line = (
        f"Right now it is {_format_pacific(input.now)} (Pacific time) — use this as ground truth "
        "for any relative date/time the user mentions (today, tomorrow, next week, etc.) when "
        "creating or checking calendar events. Never guess a date or fall back to a placeholder."
    )

    response_style_line = (
        "Default to concise: lead with the 2-3 most important points in your own words, not a raw "
        "dump of everything a tool returned. Consolidate related information rather than listing it "
        "item by item. Only go into full detail when the user actually asks for more/an explanation "
        "- and even then, organize and summarize rather than pasting raw data. If a tool result "
        "includes a documentUrl (or similar link to fuller detail), mention it so the user can read "
        "more if they want to, instead of trying to fit everything into the chat reply itself."
    )

    tool_error_line = (
        "If a tool call returns an error, don't just tell the user you'll check again later - "
        "diagnose what went wrong, make the minimal necessary change, and call it again yourself "
        "right now, in this same reply, before answering."
    )

    user_card_line = f"What you know about the user: {'; '.join(input.user_card)}" if input.user_card else ""

    user_card_for_amy_line = (
        f"Standing instructions from the user about how you should behave: {'; '.join(input.user_card_for_amy)}"
        if input.user_card_for_amy
        else ""
    )

    relevant_memories_line = (
        "Possibly relevant things from earlier conversations:\n"
        + "\n".join(f"- {m}" for m in input.relevant_memories)
        if input.relevant_memories
        else ""
    )

    open_tasks_line = (
        "Open tasks you're tracking across conversations, relevant to this message (use "
        "task_context_manage to check in on or advance one):\n"
        + "\n".join(f"- [task #{t.id}, {t.status}] {t.objective}" for t in input.open_tasks)
        if input.open_tasks
        else ""
    )

    relevant_goals_line = (
        "Relevant to one of the user's ongoing goals:\n"
        + "\n".join(f"- [goal #{g.id}, {g.status}] {g.title}" for g in input.relevant_goals)
        if input.relevant_goals
        else ""
    )

    open_projects_line = (
        "Projects already proposed or active (check here before calling project_propose again for "
        "something similar - if the user's idea overlaps with one of these, tell them about the "
        "existing project instead of proposing a new one):\n"
        + "\n".join(f"- [project #{p.id}, {p.status}] {p.title}" for p in input.open_projects)
        if input.open_projects
        else ""
    )

    needs_planning_line = (
        "This looks like a multi-step task. Before working on it, call task_context_manage with "
        "action='create' (if you haven't already tracked this), then action='plan' with an ordered "
        "list of concrete steps - then use action='advance_step' as each one actually completes."
        if input.needs_planning_nudge
        else ""
    )

    narrate_line = (
        "This will likely take a moment (multiple steps or a real lookup) - briefly say what you're "
        "about to do before doing it (e.g. \"I'll check your calendar first...\"), so it's clear "
        "something's happening rather than leaving the user waiting with no context."
        if input.narrate_before_slow_answer
        else ""
    )

    skills_line = f"Skills you have learned:\n\n{input.skills_catalog_text}" if input.skills_catalog_text else ""

    sections = [
        input.persona_system_prompt,
        date_line,
        response_style_line,
        tool_error_line,
        user_card_line,
        user_card_for_amy_line,
        relevant_memories_line,
        open_tasks_line,
        relevant_goals_line,
        open_projects_line,
        needs_planning_line,
        narrate_line,
        skills_line,
    ]
    return "\n\n".join(s for s in sections if s)
