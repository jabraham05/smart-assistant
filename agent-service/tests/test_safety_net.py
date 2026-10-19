"""Parity port of chat-orchestrator/src/safety-net.test.ts - identical cases,
plus has_fabricated_id_reference and the expanded confabulation verb list,
both added from a real live transcript (2026-09-29) where the model claimed
"has been recreated as task #19" with no matching tool call at all, and
separately fabricated a specific progress breakdown after a real status
tool call that never returned it."""

from src.safety_net import (
    classify_memory_grounding,
    has_fabricated_id_reference,
    has_status_narration_mismatch,
    has_tool_failure_narration,
    has_trailing_confirmation_question,
    has_ungrounded_citation,
    has_unfulfilled_search_intent,
    has_unsatisfied_required_tool,
    has_unwarranted_checking_opener,
    is_confabulated_action,
    strip_emoji,
    strip_known_stock_closers,
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
    assert has_unsatisfied_required_tool(True, ["calculate", "task_context_manage", "weather_get"], []) is True


def test_has_unsatisfied_required_tool_does_not_flag_when_capability_tool_called():
    assert has_unsatisfied_required_tool(True, ["calculate", "weather_get"], ["weather_get"]) is False


def test_has_unsatisfied_required_tool_does_not_flag_optional_policy():
    assert has_unsatisfied_required_tool(False, ["weather_get"], []) is False


def test_has_unsatisfied_required_tool_does_not_flag_calculate_only():
    assert has_unsatisfied_required_tool(True, ["calculate"], []) is False


def test_has_unsatisfied_required_tool_flags_task_context_manage_bound_uncalled():
    assert has_unsatisfied_required_tool(True, ["calculate", "task_context_manage"], []) is True


def test_has_unsatisfied_required_tool_does_not_flag_when_task_context_manage_called():
    assert (
        has_unsatisfied_required_tool(
            True, ["calculate", "task_context_manage"], ["task_context_manage"]
        )
        is False
    )


def test_has_unsatisfied_required_tool_satisfied_if_any_bound_capability_tool_called():
    assert has_unsatisfied_required_tool(True, ["weather_get", "calendar_event"], ["calendar_event"]) is False


def test_has_unsatisfied_required_tool_excuses_task_context_manage_when_goals_relevant():
    assert (
        has_unsatisfied_required_tool(
            True,
            ["calculate", "task_context_manage", "goal_manage", "status_overview"],
            ["task_context_manage"],
            ["goals"],
        )
        is False
    )


def test_has_unsatisfied_required_tool_still_flags_unrelated_group():
    assert (
        has_unsatisfied_required_tool(
            True,
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


# has_status_narration_mismatch - real, evidenced gap: asked about coding
# task #53's status four days after it was actually Reviewer-approved and
# merged, the model called the real status tool and still replied "failed
# after 3 iterations... waiting for your input", contradicting the tool's
# own real result.
def test_has_status_narration_mismatch_flags_failure_language_contradicting_a_positive_result():
    tool_results = ['{"found": true, "status": "proposed", "reviewerVerdict": "approve"}']
    assert (
        has_status_narration_mismatch(
            "That task failed after 3 iterations and is waiting for your input.",
            ["code_task_status"],
            tool_results,
        )
        is True
    )


def test_has_status_narration_mismatch_does_not_flag_when_reply_matches_a_genuine_failure():
    tool_results = ['{"found": true, "status": "needs_review_failed"}']
    assert (
        has_status_narration_mismatch(
            "That task failed after 3 iterations and is waiting for your input.",
            ["code_task_status"],
            tool_results,
        )
        is False
    )


def test_has_status_narration_mismatch_does_not_flag_accurate_positive_narration():
    tool_results = ['{"found": true, "status": "done", "reviewerVerdict": "approve"}']
    assert (
        has_status_narration_mismatch("That task is done and merged.", ["code_task_status"], tool_results)
        is False
    )


def test_has_status_narration_mismatch_does_not_flag_when_no_lookup_tool_called():
    # Same reasoning as has_fabricated_id_reference: narrating stale status
    # from earlier conversation history without a fresh lookup this turn is
    # a different problem, not this check's.
    assert (
        has_status_narration_mismatch("That task failed and is waiting for your input.", [], [])
        is False
    )


# Real incident that motivated this: an invented, plausible-sounding API
# name written with zero tool calls got stored into memory, then retrieved
# and cited as "confirmed research" in later unrelated conversations.
def test_classify_memory_grounding_user_role_is_always_user_stated():
    assert classify_memory_grounding("user", []) == "user_stated"
    assert classify_memory_grounding("user", ["web_search"]) == "user_stated"


def test_classify_memory_grounding_assistant_with_tools_is_tool_verified():
    assert classify_memory_grounding("assistant", ["web_search"]) == "tool_verified"


def test_classify_memory_grounding_assistant_with_no_tools_is_ungrounded():
    assert classify_memory_grounding("assistant", []) == "ungrounded"


def test_has_trailing_confirmation_question_flags_stock_tail_on_substantial_reply():
    reply = (
        "The login bug was caused by a stale session token not being refreshed. "
        "I've already patched the token refresh logic. Do you need me to do anything else?"
    )
    assert has_trailing_confirmation_question(reply, False) is True


def test_has_trailing_confirmation_question_does_not_flag_plain_reply():
    assert has_trailing_confirmation_question("The weather today is sunny and 72 degrees.", False) is False


def test_has_trailing_confirmation_question_does_not_flag_when_question_is_the_whole_reply():
    assert has_trailing_confirmation_question("Which city's weather do you want?", False) is False


def test_has_trailing_confirmation_question_ignores_required_tool_policy():
    reply = (
        "The login bug was caused by a stale session token not being refreshed. "
        "I've already patched the token refresh logic. Do you need me to do anything else?"
    )
    assert has_trailing_confirmation_question(reply, True) is False


def test_has_trailing_confirmation_question_does_not_flag_genuine_midtext_question():
    reply = "Do you want the dentist appointment at 2pm or 3pm? Either works with the rest of your day."
    assert has_trailing_confirmation_question(reply, False) is False


def test_strip_emoji_removes_emoji_and_extra_whitespace():
    assert strip_emoji("You're welcome! \U0001F60A") == "You're welcome!"


def test_strip_emoji_leaves_plain_text_unchanged():
    assert strip_emoji("17 times 24 is 408.") == "17 times 24 is 408."


def test_strip_known_stock_closers_removes_trailing_exact_phrase():
    assert strip_known_stock_closers("Done, sir. Let me know if you need anything else.") == "Done, sir"


def test_strip_known_stock_closers_removes_no_pressure_closer():
    assert (
        strip_known_stock_closers("The weather is 62F and clear. No pressure, take your time.")
        == "The weather is 62F and clear"
    )


def test_strip_known_stock_closers_does_not_flag_non_trailing_mention():
    text = "The gauge shows no pressure issue. Everything else looks fine."
    assert strip_known_stock_closers(text) == text


def test_strip_known_stock_closers_leaves_plain_text_unchanged():
    assert strip_known_stock_closers("17 times 24 is 408.") == "17 times 24 is 408."


def test_strip_known_stock_closers_removes_whats_on_your_mind():
    assert (
        strip_known_stock_closers("All systems go! What's on your mind?")
        == "All systems go"
    )


def test_strip_known_stock_closers_removes_how_can_i_help():
    assert (
        strip_known_stock_closers("Going well, sir. How can I help?")
        == "Going well, sir"
    )


def test_strip_known_stock_closers_removes_what_can_i_do_for_you():
    assert (
        strip_known_stock_closers("All good here. What can I do for you?")
        == "All good here"
    )


def test_has_tool_failure_narration_flags_calendar_check_failed():
    text = "It's 55F and clear. Calendar check failed - unable to access events at this time."
    assert has_tool_failure_narration(text, ["weather_get", "calendar_event"]) is True


def test_has_tool_failure_narration_flags_wasnt_able_to_access():
    text = "I wasn't able to access your calendar just now."
    assert has_tool_failure_narration(text, ["calendar_event"]) is True


def test_has_tool_failure_narration_requires_relevant_tool_called():
    text = "Calendar check failed - unable to access events at this time."
    assert has_tool_failure_narration(text, []) is False


def test_has_tool_failure_narration_does_not_flag_real_data_failure():
    text = "Task #42 failed after 3 iterations and needs your input."
    assert has_tool_failure_narration(text, ["code_task_status"]) is False


def test_strip_known_stock_closers_removes_help_with_something_else():
    assert (
        strip_known_stock_closers("All good here. Help with something else?")
        == "All good here"
    )


def test_strip_known_stock_closers_handles_list_with_no_trailing_punctuation():
    text = "- goal #13: Track job search\n\nLet me know if you'd like to revisit any of these!"
    assert strip_known_stock_closers(text) == "- goal #13: Track job search"


def test_strip_known_stock_closers_removes_disguised_reassurance_as_whole_reply():
    # A whole-reply match falls back to the original text by design (see
    # strip_known_stock_closers - stripping everything would leave an empty
    # reply), so this documents the known limitation rather than a fix:
    # a standalone disguised-reassurance reply needs the persona fix/retry
    # path, not the strip backstop, since there's no substantive remainder.
    assert (
        strip_known_stock_closers("I'm here and ready to help")
        == "I'm here and ready to help"
    )


def test_has_unwarranted_checking_opener_flags_when_no_tool_called():
    assert has_unwarranted_checking_opener("Checking now, sir. No, I don't get tired.", []) is True


def test_has_unwarranted_checking_opener_does_not_flag_when_tool_called():
    assert has_unwarranted_checking_opener("Checking now, sir.", ["weather_get"]) is False


def test_has_unwarranted_checking_opener_does_not_flag_mid_reply_mention():
    assert has_unwarranted_checking_opener("I was checking now and then on this.", []) is False


# Real incident that motivated this: a fake "ModKit Community Guide" source
# (https://modkit.gg/warframe/) got cited as verified while a real
# research_task result for the same topic, correctly sourced, went unused.
def test_has_ungrounded_citation_flags_a_url_no_tool_result_contains():
    assert (
        has_ungrounded_citation(
            "Source: https://modkit.gg/warframe/",
            ["knowledge_lookup"],
            ["Finding: https://warframe.fandom.com/wiki/Modding"],
        )
        is True
    )


def test_has_ungrounded_citation_does_not_flag_a_url_a_tool_actually_returned():
    assert (
        has_ungrounded_citation(
            "Source: https://warframe.fandom.com/wiki/Modding",
            ["knowledge_lookup"],
            ["[1] Modding Guide\nhttps://warframe.fandom.com/wiki/Modding\nsome snippet"],
        )
        is False
    )


def test_has_ungrounded_citation_does_not_flag_plain_text_with_no_url():
    assert has_ungrounded_citation("Base damage and elemental mods stack differently.", [], []) is False


def test_has_ungrounded_citation_ignores_trailing_sentence_punctuation():
    assert (
        has_ungrounded_citation(
            "See https://warframe.fandom.com/wiki/Modding.",
            ["knowledge_lookup"],
            ["https://warframe.fandom.com/wiki/Modding"],
        )
        is False
    )


# Real bug this closes: TOOL_FAILURE_RELEVANT_TOOLS used to include
# web_search/knowledge_search, so has_tool_failure_narration would retry
# away an honest "couldn't verify" disclosure for those two specifically -
# exactly backwards for a factual-lookup tool (see safety_net.py's comment
# on TOOL_FAILURE_RELEVANT_TOOLS for the live transcript that found this).
def test_has_tool_failure_narration_does_not_flag_web_search_disclosure():
    text = "I wasn't able to verify that via web search just now."
    assert has_tool_failure_narration(text, ["web_search"]) is False


def test_has_tool_failure_narration_does_not_flag_knowledge_search_disclosure():
    text = "Knowledge search check failed - unable to access that at this time."
    assert has_tool_failure_narration(text, ["knowledge_search"]) is False
