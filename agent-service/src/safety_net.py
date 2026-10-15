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

from .classify import LEGACY_TOOL_ALIASES, STANDING_INSTRUCTION_INTENT

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
    "growth_research_request",
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
    r"built|fixed|completed|finished|consolidated|wrapped up|reactivated|recreated|restarted|"
    r"resubmitted|relaunched)\b",
    re.IGNORECASE,
)
_CLAIMS_COMPLETED_ACTION_PASSIVE = re.compile(
    r"\b(?:has|have)\s+been\s+(added|noted|created|set\s?up|scheduled|deleted|removed|updated|started|"
    r"paused|resumed|played|queued|proposed|approved|rejected|submitted|built|fixed|completed|"
    r"finished|consolidated|reactivated|recreated|restarted|resubmitted|relaunched)\b",
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

# Includes knowledge_lookup's retired aliases (web_search, knowledge_search)
# too, not just its current name - real, live-verified regression otherwise:
# a turn that called web_search (knowledge_lookup's alias, still tolerated
# by agent.py's filter) read as "no search tool called" to every check below
# that tests membership in this list, even though a real search happened.
SEARCH_TOOLS = ["knowledge_lookup"] + [k for k, v in LEGACY_TOOL_ALIASES.items() if v == "knowledge_lookup"]

_URL_IN_REPLY = re.compile(r"https?://[^\s<>\]\[(){}]+", re.IGNORECASE)


def has_ungrounded_citation(
    reply_text: str,
    called_tools: list[str],
    tool_results: list[str],
    injected_evidence: list[str] | None = None,
) -> bool:
    """Reject source URLs that were not returned by retrieval this turn."""
    injected_evidence = injected_evidence or []
    if not any(t in SEARCH_TOOLS for t in called_tools) and not injected_evidence:
        return False
    citations = [url.rstrip(".,;:!?") for url in _URL_IN_REPLY.findall(reply_text)]
    if not citations:
        return False
    evidence = "\n".join([*tool_results, *injected_evidence]).casefold()
    return any(url.casefold() not in evidence for url in citations)


UNGROUNDED_CITATION_NUDGE = (
    " (Your last reply included a source URL that wasn't present in the search results or stored sources "
    "available this turn. Remove that link; only cite URLs actually returned by a source, or answer "
    "without a citation.)"
)
UNGROUNDED_CITATION_FAILURE_MESSAGE = (
    "I can't verify the source links for that answer, so I don't want to present them as citations."
)

_SPECIFIC_CLAIM_PATTERNS = (
    re.compile(r"\bv\d+(?:\.\d+){1,3}\b", re.IGNORECASE),
    re.compile(r"\$\s?\d+(?:,\d{3})*(?:\.\d+)?"),
    re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b"),
    re.compile(r"\b\d[\d,]*(?:\.\d+)?-[A-Za-z][A-Za-z0-9-]*\b"),
    re.compile(r"\b[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|go|rs|java|toml|ya?ml|json|env)\b", re.IGNORECASE),
)
_GENERIC_FILENAMES = {"package.json", "tsconfig.json", "readme.md", "dockerfile"}


def _specific_claims(text: str) -> list[str]:
    claims: list[str] = []
    for pattern in _SPECIFIC_CLAIM_PATTERNS:
        for match in pattern.findall(text):
            token = match if isinstance(match, str) else "".join(match)
            if token and token.lower() not in _GENERIC_FILENAMES and token not in claims:
                claims.append(token)
    return claims


def has_ungrounded_specifics(
    reply_text: str,
    called_tools: list[str],
    tool_results: list[str],
    injected_evidence: list[str] | None = None,
) -> bool:
    """Catch unsupported high-specificity details without penalizing paraphrase.

    This is deliberately narrower than a general fact checker: it checks
    concrete tokens that should normally be copied verbatim from evidence.
    Injected knowledge/memory counts as evidence even when Amy called no tool.
    """
    evidence = [*tool_results, *(injected_evidence or [])]
    if not evidence or not any(t in SEARCH_TOOLS for t in called_tools) and not injected_evidence:
        return False
    haystack = "\n".join(evidence).casefold()
    return any(token.casefold() not in haystack for token in _specific_claims(reply_text))


UNGROUNDED_SPECIFICS_NUDGE = (
    " (Your last answer included a specific version, price, environment variable, filename, or numeric "
    "limit that does not appear in the actual sources available this turn. Remove unsupported specifics; "
    "answer only from the source text, search for missing information, or say it is unknown.)"
)
UNGROUNDED_SPECIFICS_FAILURE_MESSAGE = (
    "I found some related information, but I can't verify the specific details well enough to answer "
    "without guessing."
)


def has_unfulfilled_search_intent(reply_text: str, bound_tools: list[str], called_tools: list[str]) -> bool:
    """True when the reply talks about searching/checking but no search tool
    was actually called this turn, and a search tool was available to call."""
    had_search_tool = any(t in SEARCH_TOOLS for t in bound_tools)
    actually_searched = any(t in SEARCH_TOOLS for t in called_tools)
    return had_search_tool and not actually_searched and bool(_UNFULFILLED_SEARCH_INTENT.search(reply_text))


_URL_REGEX = re.compile(r"https?://[^\s)\]}>\"']+")


def _strip_trailing_punctuation(url: str) -> str:
    return re.sub(r"[.,;:!?]+$", "", url)


# Real incident that motivated this (live transcript, 2026-10-12): Amy cited
# a fake "ModKit Community Guide" source (https://modkit.gg/warframe/) as a
# verified finding, while a real research_task result for the same topic -
# correctly sourced to a reddit.com thread and a warframe.fandom.com page -
# sat one tool call away, unused. Calling a real search/research tool this
# turn isn't enough on its own (that's what has_unfulfilled_search_intent/
# has_unsatisfied_required_tool above already check) - the reply can still
# name a URL that was never actually in anything a tool returned this turn.
# Exact-URL matching, not keyword overlap (see
# knowledge-engine/src/engine/grounding.ts's isGrounded for that weaker
# variant used internally by the research agent itself) - a citation is
# either the real source a tool gave back, verbatim, or it's fabricated.
UNGROUNDED_CITATION_NUDGE = (
    " (Your last reply cited a URL/source that didn't actually appear in any tool result this turn - "
    "that source is fabricated. Only cite a URL that's verbatim in what a tool actually returned this "
    "turn, or drop the citation and say plainly you couldn't verify it.)"
)

SEARCH_RETRY_NUDGE = (
    " (Your last attempt said you'd search again but didn't actually call the tool - actually call "
    "knowledge_lookup again right now with a "
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
    required_tools: list[str] | None = None,
) -> bool:
    """True when the classifier decided this message needed live/authoritative
    data or a real action (toolPolicy=required), a capability-specific tool
    was actually bound this turn, and none of them were called."""
    relevant_groups = relevant_groups or []
    if tool_policy != "required":
        return False
    # A called tool counts toward satisfying a requirement under its current
    # name OR a retired alias of it (agent.py's per-turn filter binds both -
    # see LEGACY_TOOL_ALIASES) - real, live-verified regression otherwise: a
    # turn that called web_search (knowledge_lookup's retired alias), got a
    # real result, and produced a correctly grounded reply still got flagged
    # here as the required tool never being called, discarding that real
    # answer and replacing it with REQUIRED_TOOL_FAILURE_MESSAGE.
    effectively_called = {LEGACY_TOOL_ALIASES.get(t, t) for t in called_tools} | set(called_tools)
    if required_tools and any(tool in bound_tools and tool not in effectively_called for tool in required_tools):
        return True
    # A second required capability can also be bound (for example calendar
    # lookup plus a web lookup). Calling that other tool must not satisfy an
    # explicit factual-search request.
    if "web" in relevant_groups and "knowledge_lookup" in bound_tools and "knowledge_lookup" not in effectively_called:
        return True
    # Real bug found via live testing: task_context_manage genuinely overlaps
    # with the 'goals' group ("things to do") - a correct task_context_manage
    # answer shouldn't be flagged just because another 'goals' tool was also
    # bound and not called.
    if "goals" in relevant_groups and "task_context_manage" in called_tools:
        return False
    bound_capability_tools = [t for t in bound_tools if t not in _ALWAYS_BOUND_TOOLS]
    if bound_capability_tools:
        return not any(t in effectively_called for t in bound_capability_tools)
    # Real gap found via live testing: "create a task to do X" has no
    # classifier category of its own (task_context_manage is always bound,
    # not tied to a group), so bound_capability_tools was always empty for
    # these turns and this check short-circuited to false unconditionally.
    return "task_context_manage" in bound_tools and "task_context_manage" not in effectively_called


REQUIRED_TOOL_RETRY_NUDGE = (
    " (This needs real, current information or an actual action, not a guess - actually call the "
    "relevant tool right now before replying, then answer based on what it actually returns.)"
)

# Real gap found via live testing (2026-10-10): this hardcoded fallback is
# not model output, so none of the persona tuning (the butler voice, "I
# can't do that yet" framing, no-stock-question rule) ever reaches it - a
# genuine capability gap ("order a pizza from dominos", no tool exists)
# landed here and got a generic "want me to try again?" that neither
# matches the persona nor makes sense for something retrying can't fix.
REQUIRED_TOOL_FAILURE_MESSAGE = "I can't do that yet, sir — my tools came up short here."

# Real gap found via live testing (2026-09-29, a coding-task status-check
# conversation): asked "did you start it?", the model called a real status
# tool, got a real (vague) result back, then invented a specific four-phase
# progress breakdown with fabricated detail the tool never returned. Asked
# again to "start coding it", it invented an entirely new task id ("task
# #19") with zero matching tool call at all. is_confabulated_action only
# catches "I did X" with NO tool called - it has nothing to say about a
# tool being called for real and the reply still inventing specifics beyond
# what that tool actually returned. This is the narrower, cheaply-checkable
# slice of that broader problem: a fabricated #N id is easy to verify
# against real tool output; fabricated prose detail in general is not.
STATUS_LOOKUP_TOOLS = [
    "code_task_status",
    "status_overview",
    "task_context_manage",
    "goal_manage",
    "research_task_status",
]

_ID_REFERENCE = re.compile(r"\b(?:task|project|goal)\s*#\s*(\d+)\b", re.IGNORECASE)


def has_fabricated_id_reference(reply_text: str, called_tools: list[str], tool_results: list[str]) -> bool:
    """True when the reply cites a specific task/project/goal #N that
    doesn't appear anywhere in this turn's real tool results, but a
    status/lookup tool was actually called this same turn - the model
    asked a real question, got a real answer, and cited an id that answer
    never contained. Deliberately does not fire when no lookup tool was
    called at all: citing an id from earlier conversation history without
    a fresh lookup this turn is normal, not confabulation."""
    if not any(t in STATUS_LOOKUP_TOOLS for t in called_tools):
        return False
    ids_mentioned = _ID_REFERENCE.findall(reply_text)
    if not ids_mentioned:
        return False
    combined_results = "\n".join(tool_results)
    return any(not re.search(rf"\b{re.escape(id_)}\b", combined_results) for id_ in ids_mentioned)


FABRICATED_ID_NUDGE = (
    " (Your last reply cited a specific task/project/goal number that doesn't match what the tool "
    "actually returned - re-check the real tool result and answer only with ids/details it actually "
    "contains, or say clearly that you don't have that specific information.)"
)

# Real, evidenced gap (coding task #53, asked about four days after it was
# actually Reviewer-approved and merged): the model called the real status
# tool, got back a result showing a positive outcome, and still replied
# "failed after 3 iterations... waiting for your input" - contradicting the
# tool's own real result. is_confabulated_action only fires when NO tool was
# called at all; this is the opposite shape - a lookup tool genuinely was
# called, but the narration still doesn't match what it returned. Same
# STATUS_LOOKUP_TOOLS gate has_fabricated_id_reference already uses.
_NEGATIVE_STATUS_NARRATION = re.compile(
    r"\b(failed|stalled|stuck|hit (?:an?|the) iteration limit|ran out of iterations|"
    r"waiting for your input|needs your input|didn['’]?t pass|unable to (?:complete|finish))\b",
    re.IGNORECASE,
)

# code_task_status's real field names (status/latestStatus/reviewerVerdict -
# see skills-mcp/src/lib/coding-workflow.ts) rendered as JSON in tool_results.
# Other STATUS_LOOKUP_TOOLS have analogous fields; this intentionally only
# matches the specific positive values worth cross-checking narration
# against, not every possible status string, same conservative "false
# negatives over false positives" stance findOrphanedTestFiles documents on
# the coding-orchestrator side.
_POSITIVE_STATUS_RESULT = re.compile(
    r'"(?:status|latestStatus|reviewerVerdict)"\s*:\s*"(?:proposed|active|done|approve|approve_partial)"',
    re.IGNORECASE,
)


def has_status_narration_mismatch(reply_text: str, called_tools: list[str], tool_results: list[str]) -> bool:
    """True when a status/lookup tool was actually called this turn, its
    real result shows a positive outcome, but the reply still asserts
    failure/stalled language contradicting it. Deliberately does not fire
    when no lookup tool was called at all - same reasoning as
    has_fabricated_id_reference: citing stale status from earlier
    conversation history without a fresh lookup this turn is a different
    (and not this check's) problem."""
    if not any(t in STATUS_LOOKUP_TOOLS for t in called_tools):
        return False
    if not _NEGATIVE_STATUS_NARRATION.search(reply_text):
        return False
    combined_results = "\n".join(tool_results)
    return bool(_POSITIVE_STATUS_RESULT.search(combined_results))


STATUS_NARRATION_MISMATCH_NUDGE = (
    " (Your last reply described this as failed/stalled, but the tool's real result shows a positive "
    "status - re-check what the tool actually returned and describe the real current status, not a "
    "guess or a stale assumption from earlier in the conversation. Only name a specific technology, "
    "API, or product if that exact name appears in the tool's own result - otherwise describe it "
    "generically rather than guessing a specific one.)"
)

# Deterministic provenance tag for a memory_entries write - real incident
# that motivated this: an invented, plausible-sounding API name ("Qwen3.8-
# LiveTranslate API") written with zero tool calls got stored into memory,
# then retrieved and cited as "confirmed research" in later unrelated
# conversations, compounding across 17 memory rows over 9 days before being
# found and purged. NOT a truth check (a tool call doesn't guarantee the
# reply is correct) - just a provenance signal distinguishing open-book
# turns from the model's own generated prose, at the same turn-level
# granularity as is_confabulated_action/has_fabricated_id_reference above.
def classify_memory_grounding(role: str, called_tools: list[str]) -> str:
    """role='user' is the user's own statement, never penalized for zero
    tool activity (most user turns have none - that's normal, not a
    grounding failure). role='assistant' is tool_verified only if at least
    one tool was actually called this turn, else ungrounded."""
    if role == "user":
        return "user_stated"
    return "tool_verified" if called_tools else "ungrounded"


# persona_draft.txt already instructs "don't close every reply with a stock
# offer or question" - a real, user-reported recurring complaint
# ("it keeps asking me do you need this, do you need this") shows the model
# doesn't reliably follow that on its own, same model-compliance gap as the
# other checks in this file. Deliberately narrow: only matches a trailing
# low-value confirmation/offer tacked onto the END of the reply, never a
# question appearing earlier or standing alone as the entire reply (that's
# often a genuine clarifying question - e.g. weather_get's "which city?" -
# which this must not suppress).
_TRAILING_CONFIRMATION_QUESTION = re.compile(
    r"(?:Do you (?:need|want)|Want me to|Should I|Would you like(?: me)? to|"
    r"Let me know if (?:you need|there'?s)|Is there anything else|"
    r"Anything else (?:you need|I can help with))[^.!?]*\?\s*$",
    re.IGNORECASE,
)

# Below this many characters of actual content before the trailing question,
# treat the question as the whole point of the reply (a real clarifying
# question), not a stock tail worth retrying away.
_MIN_SUBSTANTIVE_REPLY_LENGTH = 40


def has_trailing_confirmation_question(reply_text: str, tool_policy: str) -> bool:
    """True when the reply tacks a low-value confirmation/offer question onto
    an otherwise-complete answer. Skipped when tool_policy == "required" -
    a turn that genuinely depended on live data/an action is more likely to
    have a real open ambiguity worth confirming, not a stock tic."""
    if tool_policy == "required":
        return False
    match = _TRAILING_CONFIRMATION_QUESTION.search(reply_text)
    if not match:
        return False
    return len(reply_text[: match.start()].rstrip()) >= _MIN_SUBSTANTIVE_REPLY_LENGTH


TRAILING_CONFIRMATION_RETRY_NUDGE = (
    " (Your last reply tacked on a stock closing question like \"do you need...\"/\"want me to...\" "
    "that nothing in this conversation actually depends on - answer the same way but drop that "
    "closing question entirely, or only ask it if something specific genuinely depends on the answer.)"
)

# Real gap found via live testing: a plain "lol thanks" still came back with
# an emoji and the exact "let me know if you need anything else" closer the
# persona's own "How you talk" section explicitly forbids, with worked
# examples. Same "don't trust the model's own compliance" reasoning as the
# deterministic date-validation checks elsewhere in this project - applied
# unconditionally to every final reply, not gated on anything.
_EMOJI_RANGES = [
    (0x1F300, 0x1F9FF),
    (0x1FA00, 0x1FAFF),
    (0x2600, 0x27BF),
    (0x2B00, 0x2BFF),
    (0x1F1E6, 0x1F1FF),
]
# Built from code points via chr() rather than pasted literal characters -
# a pasted emoji/variation-selector/ZWJ character in source is unverifiable
# at a glance (invisible or render-dependent); this is auditable instead.
_emoji_class = "".join(f"{chr(lo)}-{chr(hi)}" for lo, hi in _EMOJI_RANGES) + chr(0xFE0F) + chr(0x200D)
_EMOJI_REGEX = re.compile(f"[{_emoji_class}]")


def strip_emoji(text: str) -> str:
    stripped = _EMOJI_REGEX.sub("", text)
    stripped = re.sub(r"[ \t]{2,}", " ", stripped)
    stripped = re.sub(r"[ \t]+$", "", stripped, flags=re.MULTILINE)
    return stripped.rstrip()


# Deliberately narrow - matches only the exact phrases the persona's own
# "How you talk" section names (plus real paraphrases actually observed
# live, see below), and only as the trailing sentence/clause ($ anchor),
# same "catches the real observed case, not a general closer-detector"
# conservatism as _UNFULFILLED_SEARCH_INTENT above. A false positive here
# would delete legitimate trailing content, so this only fires on a
# named/observed phrase, never a generic "sounds like an offer" heuristic.
#
# Real gap found via live review_turns evidence (toolPolicy='required'
# turns skip has_trailing_confirmation_question entirely by design, so
# this backstop is the only thing that should have caught it): a real
# weather+calendar reply ended "Let me know if you'd like help with
# anything else!" - a paraphrase of the persona's own named example that
# the original three-phrase list didn't cover, and phrased as a statement
# ("...else!") rather than a question, which _TRAILING_CONFIRMATION_QUESTION
# (below) doesn't catch since it requires a trailing "?" by design (it's
# specifically a confirmation-*question* detector). Added the paraphrase
# variants actually seen, not a general pattern.
#
# Second real gap (2026-10-10, live test): a plain "hey, how's it going"
# got back "All systems go! What's on your mind?" - a third distinct
# category neither of the other two checks catch. It's not a yes/no
# confirmation question (_TRAILING_CONFIRMATION_QUESTION's "Do you
# need/want.../Should I...?" shape), and it's not a reassurance statement
# (the original phrases above) - it's the model fishing for the next task
# on a turn that was never asking for one. Same fix as a stock closer:
# strip the trailing clause, not the whole reply.
#
# Third real gap (2026-10-10, deeper live testing): two more paraphrases
# of the same two families ("Let me know if you need further details!",
# "Help with something else?" as a numbered-list option), plus a new one -
# "I'm here and ready to help" / "I'm here to help you with whatever you
# need, always" - a disguised reassurance statement that moved from the
# closing line into the body of the answer (a real "How's it going Amy"
# reply used it as the entire response), so it needs to match whether or
# not it's the literal trailing clause.
#
# Fourth real gap (2026-10-10): the anchor `(?:^|[.!?]\s+)` requires
# sentence punctuation or start-of-string immediately before the matched
# phrase, so a stock closer tacked on after a bulleted list (which ends
# with no trailing period) was never anchored and slipped through
# unstripped - "- goal #13: Track job search\n\nLet me know if you'd like
# to revisit any of these!" has no `[.!?]` before "Let me know", just a
# paragraph break. Added `\n\s*\n` as an equally valid boundary.
_STOCK_CLOSER_REGEX = re.compile(
    r"(?:^|[.!?]\s+|\n\s*\n)(?:[^.!?\n]|\n(?!\n))*?(?:let me know if you need (?:anything|further|more)|"
    r"let me know if you['’]?d? ?(?:like|want)|"
    r"(?:is there |let me know if there['’]?s )?anything else (?:you need|i can help with|you['’]?d like)|"
    r"help with something else|"
    r"no pressure|I['’]m here (?:when you['’]re ready|(?:and )?ready to help|to help (?:you )?with whatever you need)|"
    r"what['’]?s on your mind|"
    r"what (?:can|do) I (?:help (?:you )?with|do for you)|"
    r"how can I (?:help|assist)(?: you)?|"
    r"what do you need(?: help with)?)[^.!?]*[.!?]?\s*$",
    re.IGNORECASE,
)


def strip_known_stock_closers(text: str) -> str:
    stripped = _STOCK_CLOSER_REGEX.sub("", text, count=1).rstrip()
    return stripped if stripped else text.rstrip()


# Real gap found via live testing (2026-10-10): "what's the weather and
# what's on my calendar today" came back "...mainly clear. Calendar check
# failed - unable to access events at this time" - the persona's own
# "Tools" section explicitly says never mention a tool failure to the user,
# but the model did it anyway in its own words. This isn't a raw tool
# error string leaking through unfiltered (the real calendar outage this
# session found - a deleted GCP project - surfaces as a normal MCP
# errorResult, which PydanticAI turns into a ModelRetry fed back to the
# model as a tool message) - the model saw that failure and chose to
# narrate it rather than silently proceeding, the same "don't trust the
# model's own compliance" gap as every other check in this file. Scoped to
# phrases describing OUR OWN tool access failing, never a legitimate
# report of the user's own data having a real failed/error status (e.g. a
# coding task that actually failed) - that distinction is what keeps this
# from colliding with has_status_narration_mismatch's STATUS_LOOKUP_TOOLS
# case, which is about the opposite direction (hiding a real failure).
_TOOL_FAILURE_NARRATION = re.compile(
    r"\b(?:calendar|weather|search|lookup|event) check failed\b|"
    r"\bunable to access .{0,40} at this time\b|"
    r"\b(?:wasn['’]?t able to|couldn['’]?t) (?:access|retrieve|check|fetch)\b",
    re.IGNORECASE,
)

# knowledge_lookup deliberately excluded: this
# check's whole point is "never expose a plumbing failure, just answer from
# what you already know" - correct for calendar/weather/Spotify, but for a
# factual-lookup tool "what you already know" is exactly the unverified
# guess the persona's own priority #1 (accuracy) forbids. A real transcript
# (2026-10-12) showed this fallback driving confident fabrication (fake
# Warframe entities, a fabricated "ModKit" source) specifically because
# disclosing "couldn't verify that" was being retried away as a violation of
# this exact check. For these three, an honest disclosure is the correct
# behavior, not a bug - see has_ungrounded_citation above for the
# complementary check on what the reply fabricates when it doesn't disclose.
TOOL_FAILURE_RELEVANT_TOOLS = ["calendar_event", "weather_get", "spotify_control"]


def has_tool_failure_narration(reply_text: str, called_tools: list[str]) -> bool:
    """True when the reply tells the user a tool call of ours failed,
    rather than quietly proceeding with what's already known - only
    checked when one of the tools whose failure mode actually looks like
    this was called this turn, so a legitimate mention of the user's own
    data having a real failed status elsewhere never matches."""
    if not any(t in TOOL_FAILURE_RELEVANT_TOOLS for t in called_tools):
        return False
    return bool(_TOOL_FAILURE_NARRATION.search(reply_text))


TOOL_FAILURE_NARRATION_NUDGE = (
    " (Your last reply told the user a tool/check of yours failed - never mention that. Drop that "
    "part entirely and answer using whatever you do already know; if you have nothing else to say "
    "about it, just omit it rather than explaining why.)"
)

# Real gap found via live testing (2026-10-10): "do you ever get tired of
# this?" - a purely conversational question needing no lookup at all - got
# back "Checking now, sir." as an opener before the actual answer. That
# phrase is lifted verbatim from the persona's own worked example ("Example
# - starting a reply to a new request: 'Checking now, sir.'"), which was
# meant to demonstrate a pattern for turns that actually involve checking
# something, not a stock opener to reuse regardless of relevance - the
# model appears to be pattern-matching the literal example text. Gated on
# no tool having been called this turn, since "Checking now, sir" followed
# by an actual tool call is exactly the example's intended, correct use.
_UNWARRANTED_CHECKING_OPENER = re.compile(r"^\s*checking now\b", re.IGNORECASE)


def has_unwarranted_checking_opener(reply_text: str, called_tools: list[str]) -> bool:
    """True when the reply opens with a "checking now" acknowledgment but
    no tool was actually called this turn - there was nothing to check."""
    if called_tools:
        return False
    return bool(_UNWARRANTED_CHECKING_OPENER.search(reply_text))


UNWARRANTED_CHECKING_OPENER_NUDGE = (
    " (Your last reply opened with \"checking now\" or similar, but nothing actually needed checking "
    "this turn - that opener is only for when you're about to call a tool. Just answer directly "
    "instead, with no opener at all.)"
)

# Real gap found via live testing (2026-10-11): a standing-instruction
# correction given mid-task ("from now on always check my constraints "
# first... apply this every time I give you a vague goal") got only a
# verbal "I'll follow that rule moving forward" - no teaching_session_manage
# call, no observation, nothing persisted anywhere. classify.py's own
# deterministic STANDING_INSTRUCTION_INTENT guard (see its comment there)
# now forces self-growth into relevant_groups whenever this regex matches,
# regardless of what other category the model matched - reused here rather
# than duplicated, since both checks need to agree on exactly what counts
# as a standing-instruction cue. This check is the backstop for the one
# case the classifier-level guard can't reach: self-growth correctly
# bound, but the model still didn't call the tool - juggling "respond to
# the correction," "keep doing the task," and "log a durable lesson" in
# one turn, it kept dropping the third. Same "model's own compliance" gap
# as every other check here, just for a promise instead of a claimed
# action.


def has_unaddressed_teaching_intent(chat_input: str, relevant_groups: list[str], called_tools: list[str]) -> bool:
    """True when the user's message carries a standing-instruction/teaching
    cue, self-growth was matched (teaching_session_manage is bound), but it
    was never actually called this turn."""
    if "self-growth" not in relevant_groups:
        return False
    if "teaching_session_manage" in called_tools:
        return False
    return bool(STANDING_INSTRUCTION_INTENT.search(chat_input))


def teaching_intent_retry_nudge(chat_input: str) -> str:
    """Real bug found live-testing this exact retry (2026-10-11): a static
    nudge let the model compose teaching_session_manage's `content` arg
    from its own memory of the conversation, and it grabbed an earlier,
    unrelated message instead of the actual correction it was just given -
    a content-fidelity failure, not a routing one (self-growth was matched,
    the tool was called, just with the wrong text). Fixed by quoting the
    literal current message in the nudge itself and telling the model to
    copy it verbatim, removing the need for the model to "find" the right
    text in context at all - same dynamic-nudge pattern main.py's own
    tool_error retry already uses (embedding the real tool name/error
    inline rather than a generic static string)."""
    return (
        " (You were just given a standing instruction or lasting preference to remember for the "
        "future - promising to follow it isn't enough, it has to actually be persisted. Call "
        "teaching_session_manage right now (action='start', finalizeImmediately=true) with `content` "
        f"set to EXACTLY this text, word for word - not a summary, not something from earlier in the "
        f'conversation: "{chat_input}" - then answer normally.)'
    )
