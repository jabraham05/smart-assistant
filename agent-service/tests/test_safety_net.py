"""Parity port of chat-orchestrator/src/safety-net.test.ts - identical cases,
plus has_fabricated_id_reference and the expanded confabulation verb list,
both added from a real live transcript (2026-09-29) where the model claimed
"has been recreated as task #19" with no matching tool call at all, and
separately fabricated a specific progress breakdown after a real status
tool call that never returned it."""

from src.safety_net import (
    has_fabricated_id_reference,
    has_unfulfilled_search_intent,
    has_unsatisfied_required_tool,
    is_confabulated_action,
)


def test_is_confabulated_action_flags_claimed_action_with_no_matching_call():
    assert is_confabulated_action("I've scheduled that for you.", ["calendar_event"], []) is True


def test_is_confabulated_action_does_not_flag_real_action_actually_called():
    assert is_confabulated_action("I've scheduled that for you.", ["calendar_event"], ["calendar_event"]) is False


def test_is_confabulated_action_does_not_flag_plain_text():
    assert is_confabulated_action("The weather today is sunny.", ["weather_get"], []) is False


def test_is_confabulated_action_ignores_claim_when_no_action_tool_bound():
    assert is_confabulated_action("I've added that.", ["weather_get"], []) is False


def test_has_unfulfilled_search_intent_flags_narrated_intent_with_no_call():
    assert has_unfulfilled_search_intent("Let me search for that real quick.", ["web_search"], []) is True


def test_has_unfulfilled_search_intent_does_not_flag_when_search_tool_called():
    assert has_unfulfilled_search_intent("Let me search for that.", ["web_search"], ["web_search"]) is False


def test_has_unfulfilled_search_intent_does_not_flag_ordinary_text():
    assert has_unfulfilled_search_intent("Here's the answer directly.", ["web_search"], []) is False


def test_has_unsatisfied_required_tool_flags_required_with_no_matching_call():
    assert has_unsatisfied_required_tool("required", ["calculate", "task_context_manage", "weather_get"], []) is True


def test_has_unsatisfied_required_tool_does_not_flag_when_capability_tool_called():
    assert has_unsatisfied_required_tool("required", ["calculate", "weather_get"], ["weather_get"]) is False


def test_has_unsatisfied_required_tool_does_not_flag_optional_policy():
    assert has_unsatisfied_required_tool("optional", ["weather_get"], []) is False


def test_has_unsatisfied_required_tool_does_not_flag_calculate_only():
    assert has_unsatisfied_required_tool("required", ["calculate"], []) is False


def test_has_unsatisfied_required_tool_flags_task_context_manage_bound_uncalled():
    assert has_unsatisfied_required_tool("required", ["calculate", "task_context_manage"], []) is True


def test_has_unsatisfied_required_tool_does_not_flag_when_task_context_manage_called():
    assert (
        has_unsatisfied_required_tool(
            "required", ["calculate", "task_context_manage"], ["task_context_manage"]
        )
        is False
    )


def test_has_unsatisfied_required_tool_satisfied_if_any_bound_capability_tool_called():
    assert has_unsatisfied_required_tool("required", ["weather_get", "calendar_event"], ["calendar_event"]) is False


def test_has_unsatisfied_required_tool_excuses_task_context_manage_when_goals_relevant():
    assert (
        has_unsatisfied_required_tool(
            "required",
            ["calculate", "task_context_manage", "goal_manage", "status_overview"],
            ["task_context_manage"],
            ["goals"],
        )
        is False
    )


def test_has_unsatisfied_required_tool_still_flags_unrelated_group():
    assert (
        has_unsatisfied_required_tool(
            "required",
            ["calculate", "task_context_manage", "weather_get"],
            ["task_context_manage"],
            ["info"],
        )
        is True
    )


# Real transcript case (2026-09-29): "The translation app task has been
# recreated as task #19 and is now active." - no code_task call happened at
# all that turn. "recreated" wasn't in the verb list before this fix.
def test_is_confabulated_action_flags_recreated_with_no_matching_call():
    assert is_confabulated_action(
        "The translation app task has been recreated as task #19 and is now active.",
        ["code_task"],
        [],
    ) is True


def test_is_confabulated_action_flags_reactivated_with_no_matching_call():
    assert is_confabulated_action(
        "The coding task for your translation app has been reactivated.", ["code_task"], []
    ) is True


def test_has_fabricated_id_reference_flags_id_not_in_real_tool_result():
    tool_results = ['{"found": true, "status": "running", "attemptCount": 1}']
    assert (
        has_fabricated_id_reference(
            "The translation app task has been recreated as task #19 and is now active.",
            ["code_task_status"],
            tool_results,
        )
        is True
    )


def test_has_fabricated_id_reference_does_not_flag_id_actually_in_tool_result():
    tool_results = ['{"found": true, "taskId": 54, "status": "running"}']
    assert (
        has_fabricated_id_reference(
            "Task #54 is still running.",
            ["code_task_status"],
            tool_results,
        )
        is False
    )


def test_has_fabricated_id_reference_does_not_flag_when_no_lookup_tool_called():
    # Referencing an id from earlier conversation history without a fresh
    # lookup this turn is legitimate, not confabulation.
    assert (
        has_fabricated_id_reference("As I mentioned, project #18 is still active.", [], [])
        is False
    )


def test_has_fabricated_id_reference_does_not_flag_reply_with_no_id_reference():
    tool_results = ['{"found": true, "status": "running"}']
    assert (
        has_fabricated_id_reference("It's still running.", ["code_task_status"], tool_results)
        is False
    )
