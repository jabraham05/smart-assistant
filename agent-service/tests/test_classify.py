"""Parity port of chat-orchestrator/src/classify-tools.test.ts's pure-function
cases (expand_groups_to_tools / apply_background_override). The PydanticAI
Agent wiring itself (classify_relevant_tools) requires a live Ollama instance
and is covered by the eval-harness parity run, not unit tests here - same
"live-verified, not mocked" convention this project uses throughout."""

from src.classify import apply_background_override, expand_groups_to_tools


def test_expand_groups_to_tools_always_includes_calculate_and_task_context_manage():
    assert set(expand_groups_to_tools([])) == {"calculate", "task_context_manage", "skill_examples"}


def test_expand_groups_to_tools_maps_single_group():
    assert set(expand_groups_to_tools(["media"])) == {
        "calculate",
        "task_context_manage",
        "skill_examples",
        "spotify_control",
    }


def test_expand_groups_to_tools_dedupes_and_ignores_unknown_groups():
    tools = expand_groups_to_tools(["self-growth", "not-a-real-group"])
    assert set(tools) == {
        "calculate",
        "task_context_manage",
        "skill_examples",
        "skill_propose",
        "growth_review",
        "code_task",
        "code_task_status",
        "project_propose",
        "status_overview",
        "project_complete",
        "teaching_session_manage",
    }


def test_expand_groups_to_tools_combines_multiple_groups():
    tools = expand_groups_to_tools(["media", "scheduling"])
    assert set(tools) == {
        "calculate",
        "task_context_manage",
        "skill_examples",
        "spotify_control",
        "calendar_event",
    }


def test_apply_background_override_is_noop_when_background_false():
    tools = expand_groups_to_tools(["media"])
    background, relevant_tools = apply_background_override(False, ["media"], tools)
    assert background is False
    assert relevant_tools == tools


def test_apply_background_override_adds_research_tools_when_research_classified():
    tools = expand_groups_to_tools(["research"])
    background, relevant_tools = apply_background_override(True, ["research"], tools)
    assert background is True
    assert "research_task" in relevant_tools
    assert "research_task_status" in relevant_tools


def test_apply_background_override_adds_research_tools_when_web_classified():
    tools = expand_groups_to_tools(["web"])
    background, relevant_tools = apply_background_override(True, ["web"], tools)
    assert background is True
    assert "research_task" in relevant_tools


def test_apply_background_override_falls_back_when_nothing_backgroundable():
    tools = expand_groups_to_tools(["media"])
    background, relevant_tools = apply_background_override(True, ["media"], tools)
    assert background is False
    assert relevant_tools == tools
