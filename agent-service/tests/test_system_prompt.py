"""Parity port of chat-orchestrator/src/system-prompt.test.ts - same cases,
same intent, confirms build_system_prompt behaves identically to the TS
original (including this session's openProjects addition)."""

import re
from datetime import datetime, timezone

from src.safety_net import has_unfulfilled_search_intent
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


def test_includes_status_narration_clarify_line_always():
    prompt = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    assert "describe only what that result actually says" in prompt
    assert "Never name a specific technology, API, SDK, or product" in prompt


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


def test_voice_line_teaches_the_sir_address_and_independent_judgment():
    # New direction, added as a code-layered instruction rather than a
    # DB-stored persona edit (see system_prompt.py's comment on why) -
    # the "sir" address, the composed/dry register, and giving real
    # pushback instead of just complying all have to actually be taught.
    prompt = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    assert 'Address the user as "sir"' in prompt
    assert "composed, perceptive, quietly confident" in prompt
    assert "don't just comply or hedge" in prompt


def test_voice_line_comes_before_tone_line_which_stays_last():
    # tone_line's own closing-style admonitions must stay the very last,
    # most recent thing before generation (recency bias, see its comment)
    # - voice_line slots in immediately before it, not after.
    prompt = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    assert prompt.index('Address the user as "sir"') < prompt.index("Close naturally")


def test_tone_line_examples_never_trip_the_search_intent_safety_net():
    # Real, live-verified regression (2026-10-19, session amy-main): the
    # weather example originally taught "Let me check." as the reaction
    # beat before the answer - knowledge_lookup is unconditionally bound
    # every multi-turn call (respond.py's expand_groups_to_tools baseline),
    # so has_unfulfilled_search_intent's "let me ... check" regex false-
    # positived on a correct weather_get-backed answer that never searched
    # at all, triggering a pointless retry. Fixed by changing the example
    # text itself, not the safety-net check - this test pulls every quoted
    # "Good" example out of tone_line and asserts none of them would
    # themselves trip that check, so a future wording tweak can't
    # reintroduce the same self-inflicted false positive.
    prompt = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    tone_start = prompt.index("Close naturally")
    tone_line = prompt[tone_start:]
    good_examples = re.findall(r'Good \([^)]*\): "([^"]*)"', tone_line)
    assert len(good_examples) >= 2  # sanity check the extraction itself worked
    for example in good_examples:
        assert not has_unfulfilled_search_intent(example, ["knowledge_lookup"], []), (
            f"tone_line 'Good' example would itself trigger a search-intent retry: {example!r}"
        )


def test_tone_line_teaches_the_multi_text_beat_convention():
    # Feature B (conversational multi-text): the blank-line convention
    # BeatEmitter listens for (response_blocks.py) has to actually be
    # taught here, folded into the existing tone_line rather than a new
    # section - see that module's docstring and this file's size-sanity
    # test below for why.
    prompt = build_system_prompt(SystemPromptInput(persona_system_prompt="You are Amy.", now=NOW))
    assert "more than one distinct beat" in prompt
    assert "separated by a blank line" in prompt
    assert "don't force this onto a simple one-thought reply" in prompt


def test_fast_budget_prompt_stays_near_its_prior_documented_size():
    # Real, documented history (system_prompt.py's own comment on the
    # skills_line omission): the fast-budget prompt previously hit 41,798
    # chars and that growth is what caused a real context-dilution
    # fabrication bug. The multi-text tone addition must be folded tightly
    # into the existing tone_line, not appended as a new section - assert
    # the growth from that one edit stays small (a few hundred chars, not
    # thousands), so a future edit accidentally ballooning this doesn't
    # silently slide back toward that failure mode.
    prompt = build_system_prompt(
        SystemPromptInput(
            persona_system_prompt="You are Amy.",
            now=NOW,
            budget="fast",
            respond_instructions="x" * 10_000,
        )
    )
    assert len(prompt) < 42_500


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
