"""Parity port of chat-orchestrator/src/system-prompt.test.ts - same cases,
same intent, confirms build_system_prompt behaves identically to the TS
original (including this session's openProjects addition)."""

from datetime import datetime, timezone

from src.system_prompt import (
    OpenProject,
    OpenTask,
    RelevantGoal,
    RelevantMemory,
    SystemPromptInput,
    build_system_prompt,
)

NOW = datetime(2026, 9, 21, 12, 0, 0, tzinfo=timezone.utc)


def test_omits_empty_sections():
    prompt = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    assert prompt.startswith("You are Amy.")
    assert "Pacific time" in prompt
    assert "What you know about the user" not in prompt
    assert "Standing instructions" not in prompt
    assert "Skills you have learned" not in prompt


def test_includes_action_clarify_line_always():
    prompt = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    assert "never invent a specific technology, API, SDK, or product name" in prompt
    assert "ask the user which one they want before calling the tool" in prompt


def test_includes_tone_line_always():
    prompt = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    assert "Close naturally" in prompt
    assert "No emoji." in prompt
    assert "Bad (too long" in prompt
    assert "Bad (icon-decorated list" in prompt
    # Recency matters for a small local model - the tone reminder must be the
    # very last thing before the (absent, in this test) user turn, not buried
    # earlier in the prompt.
    assert prompt.rstrip().endswith("the bad ones'.")


def test_includes_every_section_when_populated():
    prompt = build_system_prompt(
        SystemPromptInput(
            persona_system_prompt="You are Amy.",
            now=NOW,
            user_card=["likes coffee", "works remotely"],
            user_card_for_amy=["be concise"],
            skills_catalog_text="## a-skill\ndesc\n\ninstructions",
        )
    )
    assert "What you know about the user: likes coffee; works remotely" in prompt
    assert "Standing instructions from the user about how you should behave: be concise" in prompt
    assert "Skills you have learned:\n\n## a-skill" in prompt


def test_omits_relevant_memories_when_absent_or_empty():
    prompt = build_system_prompt(
        SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW, relevant_memories=[])
    )
    assert "Possibly relevant things from earlier conversations" not in prompt


def test_includes_relevant_memories_when_populated():
    prompt = build_system_prompt(
        SystemPromptInput(
            persona_system_prompt="You are Amy.",
            now=NOW,
            relevant_memories=[
                RelevantMemory(content="mentioned a fuel sender issue on the 987", grounding="user_stated")
            ],
        )
    )
    assert "Possibly relevant things from earlier conversations:" in prompt
    assert "- mentioned a fuel sender issue on the 987" in prompt


# Real incident that motivated this: an invented, plausible-sounding API
# name written with zero tool calls got stored into memory, then retrieved
# and cited as "confirmed research" in a later, unrelated conversation. An
# ungrounded memory must render with an explicit unverified caveat so the
# model doesn't repeat it as settled fact.
def test_ungrounded_memory_renders_with_unverified_caveat():
    prompt = build_system_prompt(
        SystemPromptInput(
            persona_system_prompt="You are Amy.",
            now=NOW,
            relevant_memories=[RelevantMemory(content="Qwen3.8-LiveTranslate API supports WebRTC", grounding="ungrounded")],
        )
    )
    assert "[unverified" in prompt
    assert "Qwen3.8-LiveTranslate API supports WebRTC" in prompt


def test_tool_verified_and_user_stated_memories_render_without_caveat():
    prompt = build_system_prompt(
        SystemPromptInput(
            persona_system_prompt="You are Amy.",
            now=NOW,
            relevant_memories=[
                RelevantMemory(content="checked the calendar and found a conflict", grounding="tool_verified"),
                RelevantMemory(content="said they prefer mornings", grounding="user_stated"),
            ],
        )
    )
    assert "[unverified" not in prompt
    assert "- checked the calendar and found a conflict" in prompt
    assert "- said they prefer mornings" in prompt


def test_includes_open_tasks_and_relevant_goals_when_present():
    prompt = build_system_prompt(
        SystemPromptInput(
            persona_system_prompt="You are Amy.",
            now=NOW,
            open_tasks=[OpenTask(id=7, objective="measure the fuel sender twice", status="waiting_for_user")],
            relevant_goals=[RelevantGoal(id=3, title="increase general knowledge via daily news", status="active")],
        )
    )
    assert "Open tasks you're tracking across conversations" in prompt
    assert "[task #7, waiting_for_user] measure the fuel sender twice" in prompt
    assert "Relevant to one of the user's ongoing goals" in prompt
    assert "[goal #3, active] increase general knowledge via daily news" in prompt


def test_omits_open_tasks_goals_sections_when_empty():
    prompt = build_system_prompt(
        SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW, open_tasks=[], relevant_goals=[])
    )
    assert "Open tasks you're tracking" not in prompt
    assert "Relevant to one of the user's ongoing goals" not in prompt


def test_includes_open_projects_when_present():
    prompt = build_system_prompt(
        SystemPromptInput(
            persona_system_prompt="You are Amy.",
            now=NOW,
            open_projects=[OpenProject(id=8, title="Robotics arm design and construction basics", status="active")],
        )
    )
    assert "Projects already proposed or active" in prompt
    assert "[project #8, active] Robotics arm design and construction basics" in prompt


def test_omits_open_projects_section_when_empty_or_absent():
    prompt = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW, open_projects=[]))
    assert "Projects already proposed or active" not in prompt


def test_includes_needs_planning_nudge_only_when_set():
    with_nudge = build_system_prompt(
        SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW, needs_planning_nudge=True)
    )
    assert "action='plan'" in with_nudge

    without = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    assert "action='plan'" not in without


def test_includes_narrate_before_slow_answer_nudge_only_when_set():
    with_nudge = build_system_prompt(
        SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW, narrate_before_slow_answer=True)
    )
    assert "briefly say what you're" in with_nudge

    without = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    assert "briefly say what you're" not in without
