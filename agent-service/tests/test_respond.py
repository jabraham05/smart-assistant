"""Unit tests for src/respond.py's pure functions - expand_groups_to_tools
(parity with the old classify.py suite) and _normalize_output (the new
invariant-enforcement step). The LLM-calling path (generate_response) requires
a live Ollama instance and is covered by the eval-harness parity run, not here."""

from src.respond import AmyResponseOutput, MemorableItemOutput, _normalize_output, expand_groups_to_tools


def _output(**overrides) -> AmyResponseOutput:
    defaults = dict(
        response="",
        multiTurn=False,
        toolsNeeded=[],
        planningNeeded=False,
        deferToGrowth=False,
        knowledgeGapTopic=None,
        behaviorFeedbackCategory=None,
        behaviorFeedbackNote=None,
        memorableItems=[],
        isCorrection=False,
    )
    defaults.update(overrides)
    return AmyResponseOutput(**defaults)


def test_expand_groups_to_tools_always_includes_calculate_and_task_context_manage():
    assert set(expand_groups_to_tools([])) == {
        "calculate",
        "task_context_manage",
        "skill_examples",
        "knowledge_lookup",
    }


def test_expand_groups_to_tools_maps_single_group():
    assert set(expand_groups_to_tools(["media"])) == {
        "calculate",
        "task_context_manage",
        "skill_examples",
        "knowledge_lookup",
        "spotify_control",
    }


def test_expand_groups_to_tools_combines_multiple_groups():
    tools = expand_groups_to_tools(["media", "scheduling"])
    assert set(tools) == {
        "calculate",
        "task_context_manage",
        "skill_examples",
        "knowledge_lookup",
        "spotify_control",
        "calendar_event",
    }


def test_expand_groups_to_tools_research_group_no_longer_includes_growth_research_request():
    # growth_research_request is handled by deferToGrowth's direct call now,
    # not a model-driven tool - the group must not re-expose it.
    tools = expand_groups_to_tools(["research"])
    assert "growth_research_request" not in tools
    assert "research_task_status" in tools


def test_normalize_output_forces_relevant_tools_empty_when_not_multi_turn():
    result = _normalize_output(
        _output(multiTurn=False, toolsNeeded=["media", "scheduling"]), "play some music", None
    )
    assert result.multi_turn is False
    assert result.relevant_tools == []
    # relevant_groups still reflects what the model said, even though tools
    # are forced empty - useful for observability/trace, just inert for binding.
    assert result.relevant_groups == ["media", "scheduling"]


def test_normalize_output_populates_relevant_tools_when_multi_turn():
    result = _normalize_output(_output(multiTurn=True, toolsNeeded=["media"]), "play some music", None)
    assert result.multi_turn is True
    assert "spotify_control" in result.relevant_tools


def test_normalize_output_planning_needed_requires_multi_turn():
    result = _normalize_output(
        _output(multiTurn=False, planningNeeded=True), "plan my week", None
    )
    assert result.planning_needed is False


def test_normalize_output_defer_to_growth_zeroes_planning_needed():
    result = _normalize_output(
        _output(multiTurn=True, planningNeeded=True, deferToGrowth=True), "research this deeply and save it", None
    )
    assert result.defer_to_growth is True
    assert result.planning_needed is False


def test_normalize_output_explicit_research_request_forces_defer_to_growth():
    # Deliberately avoids "research this/that/whether" phrasing, which also
    # matches EXPLICIT_LOOKUP_INTENT - this isolates deferToGrowth's
    # independence from multi_turn without that overlap.
    result = _normalize_output(
        _output(multiTurn=False, deferToGrowth=False, response="Sure, I'll look into that."),
        "please investigate this topic thoroughly and save what you find for later",
        None,
    )
    assert result.defer_to_growth is True
    assert result.explicit_research_request is True
    # deferToGrowth is independent of multi_turn - the model's own
    # multiTurn=False (and its response) survive untouched.
    assert result.multi_turn is False
    assert result.response == "Sure, I'll look into that."


def test_normalize_output_explicit_lookup_forces_web_group_and_multi_turn():
    result = _normalize_output(
        _output(multiTurn=False, toolsNeeded=[]), "can you look that up for me", None
    )
    assert "web" in result.relevant_groups
    assert result.multi_turn is True
    assert "knowledge_lookup" in result.relevant_tools


def test_normalize_output_standing_instruction_forces_self_growth_and_multi_turn():
    result = _normalize_output(
        _output(multiTurn=False, toolsNeeded=[]), "from now on always check the calendar first", None
    )
    assert "self-growth" in result.relevant_groups
    assert result.multi_turn is True


def test_normalize_output_open_teaching_session_forces_self_growth_and_multi_turn():
    result = _normalize_output(
        _output(multiTurn=False, toolsNeeded=[]), "ok next step", None, open_teaching_session=True
    )
    assert "self-growth" in result.relevant_groups
    assert result.multi_turn is True


def test_normalize_output_unknown_group_filtered_out():
    result = _normalize_output(
        _output(multiTurn=True, toolsNeeded=["media", "not-a-real-group"]), "play music", None
    )
    assert result.relevant_groups == ["media"]


def test_normalize_output_is_correction_requires_recent_context():
    result = _normalize_output(_output(isCorrection=True), "no that's wrong", None)
    assert result.is_correction is False

    result = _normalize_output(_output(isCorrection=True), "no that's wrong", "prior exchange text")
    assert result.is_correction is True


def test_normalize_output_memorable_items_filters_unknown_types():
    result = _normalize_output(
        _output(
            memorableItems=[
                MemorableItemOutput(type="fact", content="Owns a 2019 Subaru Outback"),
                MemorableItemOutput(type="not-a-real-type", content="should be dropped"),
            ]
        ),
        "my car is a 2019 Subaru Outback",
        None,
    )
    assert len(result.memorable_items) == 1
    assert result.memorable_items[0].type == "fact"


def test_normalize_output_calculation_intent_forces_multi_turn():
    result = _normalize_output(
        _output(multiTurn=False, toolsNeeded=[], response="That would be about $11."),
        "What's a 18% tip on a $64.30 bill?",
        None,
    )
    assert result.multi_turn is True
    assert "calculate" in result.relevant_tools


def test_normalize_output_calculation_intent_ignores_unrelated_numbers():
    result = _normalize_output(
        _output(multiTurn=False, toolsNeeded=[]), "My car is a 2019 Subaru Outback.", None
    )
    assert result.multi_turn is False


def test_normalize_output_current_info_intent_forces_web_and_multi_turn():
    result = _normalize_output(
        _output(multiTurn=False, toolsNeeded=[], response="It's v20."),
        "What is the latest stable version of Node.js?",
        None,
    )
    assert result.multi_turn is True
    assert "web" in result.relevant_groups
    assert "knowledge_lookup" in result.relevant_tools


def test_normalize_output_current_info_intent_ignores_unrelated_questions():
    result = _normalize_output(
        _output(multiTurn=False, toolsNeeded=[]), "What's the capital of France?", None
    )
    assert result.multi_turn is False


def test_normalize_output_behavior_feedback_requires_known_category_and_nonempty_note():
    result = _normalize_output(
        _output(behaviorFeedbackCategory="not-a-real-category", behaviorFeedbackNote="some note"),
        "you keep doing that wrong",
        None,
    )
    assert result.behavior_feedback is None

    result = _normalize_output(
        _output(behaviorFeedbackCategory="communication", behaviorFeedbackNote="too verbose"),
        "you give me too much detail",
        None,
    )
    assert result.behavior_feedback is not None
    assert result.behavior_feedback.category == "communication"
