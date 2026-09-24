"""Direct port of chat-orchestrator/src/safety-net.ts.

Only the mechanism-independent checks from the old n8n Chat workflow's safety
net survive - a model can still narrate an unfinished search, or claim it did
something without actually calling the tool that would do it, regardless of
which agent runtime is driving the loop. PydanticAI's own retry (tool-argument
validation failures, structured-output validation) is real but scoped to
schema correctness - it does not replace these turn-level semantic checks.
"""

from __future__ import annotations

import re

# Same tool list as the old "confabulated action" backstop - tools whose
# whole point is performing a real side effect, where a claim of success
# with no matching call is worth catching.
ACTION_TOOLS = [
    "goal_manage",
    "calendar_event",
    "spotify_control",
    "dashboard_control",
    "code_task",
    "skill_propose",
    "research_task",
    "project_propose",
    # Real gap found via live testing: task_context_manage is always bound
    # (see ALWAYS_BOUND_TOOLS below), so on a turn where nothing else got
    # classified/bound, "I've created a task for X" with no real call
    # slipped past confabulation detection entirely.
    "task_context_manage",
    "project_complete",
]

_CLAIMS_COMPLETED_ACTION = re.compile(
    r"\b(?:I['’]?ve|I have)\s+(added|noted|created|set\s?up|scheduled|deleted|removed|updated|"
    r"started|paused|resumed|played|queued|turned|proposed|approved|rejected|submitted|kicked off|"
    r"built|fixed|completed|finished|consolidated|wrapped up)\b",
    re.IGNORECASE,
)
_CLAIMS_COMPLETED_ACTION_PASSIVE = re.compile(
    r"\b(?:has|have)\s+been\s+(added|noted|created|set\s?up|scheduled|deleted|removed|updated|started|"
    r"paused|resumed|played|queued|proposed|approved|rejected|submitted|built|fixed|completed|"
    r"finished|consolidated)\b",
    re.IGNORECASE,
)


def is_confabulated_action(reply_text: str, bound_tools: list[str], called_tools: list[str]) -> bool:
    """True when the reply claims to have performed a real action but no
    matching action tool was actually invoked this turn."""
    had_action_tool_bound = any(t in ACTION_TOOLS for t in bound_tools)
    claims_completed = bool(_CLAIMS_COMPLETED_ACTION.search(reply_text)) or bool(
        _CLAIMS_COMPLETED_ACTION_PASSIVE.search(reply_text)
    )
    if not claims_completed:
        return False
    actually_called_action = any(t in ACTION_TOOLS for t in called_tools)
    return had_action_tool_bound and not actually_called_action


_UNFULFILLED_SEARCH_INTENT = re.compile(
    r"\b(I['’]?ll|I will|let me|hold on|give me a (moment|second))\b[^.!?]{0,60}\b"
    r"(try|search|look(ing)?|refin(e|ing)|check|find|research(ing)?)\b",
    re.IGNORECASE,
)

SEARCH_TOOLS = ["web_search", "knowledge_search", "research_task"]


def has_unfulfilled_search_intent(reply_text: str, bound_tools: list[str], called_tools: list[str]) -> bool:
    """True when the reply talks about searching/checking but no search tool
    was actually called this turn, and a search tool was available to call."""
    had_search_tool = any(t in SEARCH_TOOLS for t in bound_tools)
    actually_searched = any(t in SEARCH_TOOLS for t in called_tools)
    return had_search_tool and not actually_searched and bool(_UNFULFILLED_SEARCH_INTENT.search(reply_text))


SEARCH_RETRY_NUDGE = (
    " (Your last attempt said you'd search again but didn't actually call the tool - actually call "
    "web_search, knowledge_search, or research_task again (whichever fits) right now with a "
    "meaningfully different query before replying. Briefly let the user know you're trying a "
    "different angle.)"
)

# Tools that don't count toward toolPolicy=required - both are bound to
# every turn regardless of classification, so their presence says nothing
# about whether the classifier's actual required capability was used.
_ALWAYS_BOUND_TOOLS = ["calculate", "task_context_manage"]


def has_unsatisfied_required_tool(
    tool_policy: str,
    bound_tools: list[str],
    called_tools: list[str],
    relevant_groups: list[str] | None = None,
) -> bool:
    """True when the classifier decided this message needed live/authoritative
    data or a real action (toolPolicy=required), a capability-specific tool
    was actually bound this turn, and none of them were called."""
    relevant_groups = relevant_groups or []
    if tool_policy != "required":
        return False
    # Real bug found via live testing: task_context_manage genuinely overlaps
    # with the 'goals' group ("things to do") - a correct task_context_manage
    # answer shouldn't be flagged just because another 'goals' tool was also
    # bound and not called.
    if "goals" in relevant_groups and "task_context_manage" in called_tools:
        return False
    bound_capability_tools = [t for t in bound_tools if t not in _ALWAYS_BOUND_TOOLS]
    if bound_capability_tools:
        return not any(t in called_tools for t in bound_capability_tools)
    # Real gap found via live testing: "create a task to do X" has no
    # classifier category of its own (task_context_manage is always bound,
    # not tied to a group), so bound_capability_tools was always empty for
    # these turns and this check short-circuited to false unconditionally.
    return "task_context_manage" in bound_tools and "task_context_manage" not in called_tools


REQUIRED_TOOL_RETRY_NUDGE = (
    " (This needs real, current information or an actual action, not a guess - actually call the "
    "relevant tool right now before replying, then answer based on what it actually returns.)"
)

REQUIRED_TOOL_FAILURE_MESSAGE = "I wasn't able to complete that using my tools just now — want me to try again?"
