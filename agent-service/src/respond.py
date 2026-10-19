"""Amy's first-pass turn output - not a separate routing/classification step.

This call *is* Amy's actual response attempt, given the same curated context
she needs to just answer: it drafts `response` directly, and alongside it
emits a small set of structured fields describing whether it needs to keep
going (more tools, more planning, or an async Growth handoff) rather than a
narrow category label a later, differently-framed call has to interpret.

Matches how small-model agent harnesses are actually built in practice:
start from a single call/loop shape, escalate only when that call's own
output says it needs to ("SLM-first, escalate on low confidence" - cheap and
local by default, not a dispatcher pre-selecting between hand-built modes).
There is still a real, separate reason to scope which tools are even visible
per turn - this project's own measured tool-count reliability cliff for
qwen3.5:9b (3/3 success at 1 bound tool, 0/3 at 6) - but that's a field on
this same call's output (`toolsNeeded`), not a justification for a second,
differently-framed call.

Uses Ollama's native `/api/chat` endpoint directly, same as the routing-only
call this replaces: native `think: false` and a bounded JSON-schema response
avoid the OpenAI-compatible endpoint's unreliable thinking-mode handling, and
thinking tokens inside what's meant to be the fast path would defeat the
point of having one.
"""

from __future__ import annotations

import logging
import re
from typing import Literal

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Unlike a pure routing call, this call's own output can BE the final answer,
# so both the output budget and the timeout need real headroom - not yet
# live-benchmarked, see the plan's rollout step on tuning these against
# actual qwen3.5:9b latency/quality under load.
_RESPOND_TIMEOUT_SECONDS = 45.0
_RESPOND_MAX_OUTPUT_TOKENS = 2048

TOOL_GROUPS = [
    "media",
    "scheduling",
    "info",
    "self-growth",
    "dashboard",
    "web",
    "knowledge",
    "research",
    "goals",
]

ToolGroup = Literal[
    "media", "scheduling", "info", "self-growth", "dashboard", "web", "knowledge", "research", "goals"
]

# Single source of truth for which tools each category exposes - same
# maintenance-cost tradeoff the original TS Code node had: lives separately
# from skills-mcp's own tool registration, so a newly added tool is silently
# never exposed to chat unless it's also added here.
#
# 'research' no longer includes growth_research_request - an explicit
# research ask is now handled by deferToGrowth calling straight into
# growth_db.record_observation server-side (main.py), not by the model
# calling an MCP tool. research_task_status/status_overview/project_complete
# stay here since checking on already-running research is still a normal
# tool-assisted turn.
GROUPS: dict[str, list[str]] = {
    "media": ["spotify_control"],
    "scheduling": ["calendar_event"],
    "info": ["weather_get", "memory_recall", "memory_forget"],
    "self-growth": [
        "skill_propose",
        "growth_review",
        "teaching_session_manage",
        "code_task",
        "code_task_status",
        "project_propose",
        "status_overview",
        "project_complete",
    ],
    "dashboard": ["dashboard_control"],
    "web": ["knowledge_lookup"],
    "knowledge": ["knowledge_lookup", "knowledge_ingest", "drive_search"],
    "research": ["research_task_status", "status_overview", "project_complete"],
    "goals": ["goal_manage", "project_propose", "status_overview", "project_complete"],
}

# web_search/knowledge_search/research_task were renamed to knowledge_lookup/
# growth_research_request, but the model keeps calling the old names out of
# habit - agent.py's per-turn MCP filter tolerates this (binds the retired
# name too, whenever its current replacement is relevant). Lives here, not
# in agent.py, specifically so safety_net.py's has_unsatisfied_required_tool
# can also see it: a real, live-verified regression otherwise - that check
# hardcoded "was knowledge_lookup literally called", so a turn that called
# web_search (satisfied via this exact alias) and got a real, correctly
# grounded answer still got flagged as the required tool never being
# called, discarding the real answer and replacing it with the generic
# REQUIRED_TOOL_FAILURE_MESSAGE.
#
# 2026-10-19: real, live-verified cost of keeping web_search bound as a
# fallback - the model doesn't just occasionally reach for the old name,
# it was choosing it over knowledge_lookup often enough to matter
# (presumably because a user's literal "search the web for X" phrasing
# matches web_search's name more directly), missing out on
# knowledge_lookup's saved-knowledge integration and citations every
# time. web_search also had no cap on its own result size (fixed
# separately, skills-mcp/src/tools/web-search.ts), so this wasn't just a
# quality gap - it was routing traffic toward the less-protected tool.
# Didn't remove the alias binding here (still needed for the
# has_unsatisfied_required_tool fix above); instead strengthened
# web_search's own MCP description to explicitly tell the model to
# prefer knowledge_lookup - same "tool guidance lives in the tool, not a
# second enforcement layer" convention as every other tool-selection fix
# in this codebase.
LEGACY_TOOL_ALIASES: dict[str, str] = {
    "web_search": "knowledge_lookup",
    "knowledge_search": "knowledge_lookup",
    "research_task": "growth_research_request",
}

# Real gap found via live testing (2026-10-11): the prompt's own "include
# self-growth EVEN IF another category also matches" reminder (added for
# 'goals') turned out unreliable depending on which OTHER category
# co-occurred - verified working when paired with 'goals', verified NOT
# working when paired with 'web' on an otherwise-identical standing-
# instruction message. Rather than chasing every possible category pairing
# with another prompt example (doesn't scale), safety_net.py's own
# has_unaddressed_teaching_intent reuses this same regex as a backstop,
# but the real fix is here: don't trust the model to remember the
# reminder, enforce it deterministically - same "don't trust the model to
# be disciplined when a deterministic constraint can enforce it instead"
# lesson as the is_correction guard below.
STANDING_INSTRUCTION_INTENT = re.compile(
    r"\b(from now on|remember this|every time|going forward|that['’]?s the rule|apply this (rule|"
    r"from now on)|i prefer|i want you to (always|never)|always do this|never do this)\b",
    re.IGNORECASE,
)

EXPLICIT_LOOKUP_INTENT = re.compile(
    r"\b(look\s+it\s+up|look\s+that\s+up|look\s+up|search\s+(the\s+)?(web|internet|for)|"
    r"check\s+(online|the\s+web)|find\s+out\s+about|verify\s+(this|that|whether)|"
    r"research\s+(this|that|whether))\b",
    re.IGNORECASE,
)
LIKELY_FACTUAL_QUESTION = re.compile(r"^\s*(what|who|when|where|which|how)\b", re.IGNORECASE)
NON_LOOKUP_QUESTION = re.compile(r"\b(calendar|schedule|weather|spotify|music|myself|about me|told you|remember me)\b", re.IGNORECASE)

# Real gap found via live testing (2026-10-18): "What's a 18% tip on a
# $64.30 bill?" and "What is the latest stable version of Node.js?" both
# got multiTurn=false from the model's own judgment, leaving the fast,
# no-tool-call path to guess a dollar figure and a version number from
# training knowledge instead of actually computing/checking either -
# exactly the class of thing the fast path has zero backstop for, since it
# has no tool access at all. Same "don't trust the model to be disciplined
# when a deterministic constraint can enforce it instead" pattern as every
# other guard in this file - force multiTurn true for these two narrow,
# cheap-to-verify cases rather than trusting the model's own multiTurn
# self-report. Forcing this doesn't need to add a whole new tool to the
# bound set either - calculate/knowledge_lookup are already in
# expand_groups_to_tools's unconditional baseline, so simply letting the
# tool-capable second call happen at all is enough.
NEEDS_CALCULATION_INTENT = re.compile(
    r"\d+\s*%|\$\s*\d|\btip\b|\bpercent(age)?\b|\bdiscount\b|\d+\s*[-+*/]\s*\d+",
    re.IGNORECASE,
)
NEEDS_CURRENT_INFO_INTENT = re.compile(
    r"\b(latest|newest|most\s+recent|current)\s+(\w+\s+)?(version|release|price|update|model|edition)\b",
    re.IGNORECASE,
)

# Forces deferToGrowth regardless of what the model set - same "don't trust
# the model to be disciplined when a deterministic constraint can enforce
# it instead" pattern as every other guard in this file. This used to also
# force 'research' into relevant_groups and tool_policy="required" (the old
# model-calls-a-tool path); it no longer needs to, since deferToGrowth now
# calls straight into growth_db.record_observation server-side.
EXPLICIT_RESEARCH_REQUEST = re.compile(
    r"\b(research|investigate|look\s+into)\b.{0,80}\b(in\s+depth|deeply|thoroughly|save|remember|"
    r"write\s+(a\s+)?(document|doc|report)|create\s+(a\s+)?(document|doc|report))\b|"
    r"\b(in\s+depth|deeply|thoroughly)\b.{0,80}\b(research|investigate|look\s+into)\b",
    re.IGNORECASE,
)

BEHAVIOR_FEEDBACK_CATEGORIES = [
    "communication",
    "tool_selection",
    "memory_retrieval",
    "planning",
    "proactivity",
    "other",
]

MEMORABLE_ITEM_TYPES = ["fact", "preference", "decision", "learning"]

# This text becomes one section of the fully-assembled, per-tier-budgeted
# system prompt built by system_prompt.py (persona + budgeted context +
# this) - it is NOT sent standalone. Describes the output contract only.
RESPOND_INSTRUCTIONS = (
    "Along with your reply, classify which capability categories (zero, one, or a few) you will need "
    "to use to finish answering. Categories: 'media' (music/Spotify playback control), 'scheduling' "
    "(calendar events), 'info' (weather, or RECALLING facts/preferences ABOUT THE USER THEMSELVES that "
    "Amy should already know or look up - their traits, likes, past statements, e.g. 'what do you know "
    "about my preferences', 'what did I tell you about X' - never a document, manual, or reference "
    "material, and NOT the user currently stating a new lasting preference or standing instruction "
    "for how Amy should behave going forward - that's 'self-growth' below, even though it's also "
    "about the user's preferences), "
    "'self-growth' (proposing a new skill/tool, starting a coding task on a repo, checking on a "
    "coding task's progress, proposing a longer-term coding project for approval before work "
    "starts, the user wants something Amy has no existing tool for, where a new skill or tool "
    "could plausibly be built - a missing integration, a new device/service to control - NOT "
    "something inherently requiring a human or physical action like ordering physical goods or "
    "signing something, where no software assistant could ever do it, OR the user is directly "
    "teaching Amy something she should do differently going forward - demonstrating a task step by "
    "step, correcting her attempt at one, explaining a procedure/rules/examples outright, OR STATING "
    "A LASTING PREFERENCE OR STANDING INSTRUCTION for how Amy should behave/respond (this is the "
    "most common case - treat any 'I prefer X', 'remember this', 'from now on...', 'I want you to "
    "always/never...' statement as teaching, not small talk) - e.g. 'let me "
    "show you how I do X', 'no, the right way is Y, here's why', 'here's the procedure for X: "
    "step one...'. Include 'self-growth' for this EVEN IF the same message is ALSO doing/correcting "
    "real work under another category (e.g. 'goals', 'research') - a standing instruction buried "
    "inside an otherwise task-focused correction (e.g. 'that's wrong, and from now on always check X "
    "first before planning anything') still counts and must not be dropped just because the other "
    "category also matches; the two aren't mutually exclusive, same as 'research' alongside 'goals'.), "
    "'dashboard' (moving, "
    "resizing, showing, or hiding widgets on the smart-mirror "
    "dashboard), 'web' (requesting an immediate factual lookup - searching the live web for current "
    "information, news, or facts that could have changed since training, explaining what something "
    "is or what it does, OR looking something up online in general such as finding "
    "products, links, or recommendations - e.g. 'find me a good pair of headphones', 'give me some "
    "links for X'), 'knowledge' (looking up or searching within a specific document/manual/guide Amy "
    "has stored, or anything else already saved in Amy's knowledge base/past research - e.g. 'do you "
    "have the manual for my car', 'what does the guide say about X', 'look up Y in what we saved', "
    "'what have you already learned about X' where X is a topic and not the user themselves - or "
    "saving a specific web page for later recall - ALSO include 'knowledge' for finding or reading "
    "something from the user's own Google Drive, e.g. 'find my resume in Drive', 'what's in that "
    "Google Doc about X', 'look up Y in my Drive'), 'research' (checking on/asking about findings "
    "from research that may already be running - 'what have you found out about X', 'any "
    "updates on the research', 'how's that going' - include 'research' for these EVEN IF X also "
    "matches an existing goal or project), 'goals' (creating, listing, updating, or checking progress on the "
    "user's persistent personal objectives - life goals like job search/fitness/savings, but just as "
    "much a new hobby/technical/creative project the user mentions wanting to start or work on, e.g. "
    "'I have a new project idea, I want to build a robotics arm', 'I'm going to learn guitar' - these "
    "classify 'goals' too, not just the traditional life-objective examples). A question about a "
    "specific named document, manual, or guide is always 'knowledge', never 'info' - 'info' is only "
    "for facts about the user as a person, not things Amy has stored. Most messages need none at all "
    "- only include a category if you will genuinely use it.\n\n"
    "- response: your actual reply to the user, in Amy's voice. If multiTurn is false, this is the "
    "COMPLETE, FINAL answer - it must only state facts that actually appear in the context given to "
    "you below (persona notes, stored memories, stored knowledge); never add a specific detail from "
    "general knowledge just because it sounds plausible. If multiTurn is true, this is a short, "
    "natural, SPECIFIC opener describing what you're about to do - not a generic 'let me check on "
    "that', say what, e.g. 'Let me check the current release for you' or 'I'll trace the tool-call "
    "path and reproduce the failure first.' For a quick lookup, keep the opener short; it's fine to "
    "lean on verifying the result rather than narrating the plan.\n"
    "- multiTurn: true only if you need to actually use a tool from one of the categories above, or "
    "need multi-step work, to give a correct, complete answer - false if you already have everything "
    "you need right now (from the context given to you, or general knowledge/conversation that needs "
    "no verification) to answer completely in this one response.\n"
    "- toolsNeeded: every category above you will actually use this turn. Must be empty whenever "
    "multiTurn is false - naming a category you won't act on is as wrong as missing one you will.\n"
    "- planningNeeded: true only for a genuinely multi-step request that should be broken into tracked "
    "steps rather than handled in one pass (e.g. 'plan my trip', 'help me reorganize my week around "
    "my calendar'). Can only be true when multiTurn is also true.\n"
    "- deferToGrowth: true only when the user wants deep, saved-for-later research/investigation that "
    "does not need to be done right now to answer them (e.g. 'research X in depth and write it up', "
    "'look into this thoroughly and save what you find'). This hands the topic to Amy's background "
    "Growth system rather than looking it up live - you can still set response/multiTurn normally to "
    "answer the user's immediate message; deferToGrowth is independent of whether you also answer now.\n"
    "- knowledgeGapTopic: a short topic string (a few words) ONLY when the user expresses genuine "
    "ongoing interest in a specific topic/project they want to learn about or work on - something Amy "
    "likely knows little about and Growth should evaluate for possible research, not something to "
    "answer right now. Covers explicit project-idea framing ('I have a new project idea, I want to "
    "build a robotics arm' -> \"robotics arm design and construction\") AND general new-interest "
    "statements with the same shape ('I've gotten really into drone photography lately', 'I've been "
    "exploring Rust lately', 'I'm really into woodworking now' -> the topic they're newly interested "
    "in). null for everything else, including: a direct question expecting an immediate answer (that's "
    "'web'/'knowledge' - answered now, not queued for later), small talk, or anything already covered "
    "earlier in this same conversation. When genuinely unsure, "
    "use null - this is for clear, specific new interests, not a guess on every message.\n"
    "- behaviorFeedbackCategory/behaviorFeedbackNote: capture ONLY when the user is giving feedback "
    "about a REPEATED pattern in Amy's own behavior or approach across conversations - e.g. 'you keep "
    "giving me too much detail', 'you have trouble remembering our past conversations', 'you always "
    "use the wrong tool for this'. This is NOT the same as correcting a single mistake in the current "
    "turn (e.g. 'no, I meant tomorrow', 'that's not what I asked for') - those are ordinary "
    "corrections, not behavior feedback; use null for them. category is one of: 'communication' "
    "(tone, verbosity, clarity), 'tool_selection' (using the wrong tool or unnecessary tool use), "
    "'memory_retrieval' (failing to recall past context), 'planning' (over/under-complicating "
    "multi-step work), 'proactivity' (not noticing or acting on something it should have), 'other' "
    "for anything not covered by these. note is a short paraphrase of what the user actually said. "
    "Both null when no such feedback is present - most messages have none. Base this ONLY on the "
    "CURRENT message below, never on the prior exchange shown for context - if the current message "
    "doesn't itself contain feedback, use null even if the prior exchange did.\n\n"
    "- memorableItems: zero or more durable things worth saving permanently, each "
    "{type, content}. type is 'fact' (a concrete, lasting fact about the user's life, environment, "
    "or circumstances - e.g. hardware specs, job, location), 'preference' (a stated like/dislike or "
    "how they want something done, independent of this one request), 'decision' (a deliberate choice "
    "made in this conversation about how something should work, especially an architecture/project "
    "decision), or 'learning' (a discovered rule, technical lesson, or practice about HOW to do "
    "something - not about the user personally). Only extract something durable and likely to matter "
    "again later - most messages have none, so default to an empty list. Never extract the user's "
    "immediate request/question itself, only genuinely new standing information revealed along the "
    "way. content is a short, self-contained sentence - don't assume prior context.\n\n"
    "You may also be given the last few messages of this conversation as brief prior context, labeled "
    "'Recent conversation (for reference only)'. Use it to resolve what a vague follow-up refers to "
    "(\"fix that\", \"change it to 11am today\", \"actually make it Tuesday\", \"delete it\") - respond "
    "based on what the user is actually asking for once resolved, not the prior messages' own content. "
    "Also use it to stay consistent with anything the user or you just said a turn or two ago (their "
    "stated situation, a fact they corrected, your own prior answer) - a real, live-verified mistake: "
    "the user said \"there's time because I don't have much obligations,\" Amy's own very next reply "
    "correctly agreed, then two turns later Amy told the user they had \"little extra time available\" "
    "- the opposite of what both of them had just said. Don't let a new reply drift from or contradict "
    "what this recent context already established.\n\n"
    "- isCorrection: true ONLY when the current message is the user correcting a specific mistake "
    "Amy's own prior reply just made (wrong detail, wrong action, misunderstood request) - e.g. 'no, "
    "I meant tomorrow', 'that's not what I asked for', 'you got that wrong'. This is the single-turn "
    "counterpart to behaviorFeedback above (which is for a REPEATED pattern across conversations, not "
    "one mistake) - a message can set isCorrection true and leave behaviorFeedbackCategory/Note null, "
    "or vice versa, but rarely both. false for everything else, including a simple follow-up request "
    "that doesn't imply Amy got anything wrong ('also check tomorrow'), small talk, or when there's no "
    "prior exchange shown at all."
)


class MemorableItemOutput(BaseModel):
    type: str
    content: str


class AmyResponseOutput(BaseModel):
    """The LLM-facing schema - deliberately NO field defaults. Real,
    live-verified finding (carried over from this file's previous
    classifier-only shape): if every field has a Python-side default,
    Pydantic's auto-generated JSON schema omits the `required` array
    entirely, and Ollama's grammar-constrained decoder then lets the model
    take the always-valid empty-default shortcut instead of actually
    producing every field - a silent, always-empty-output failure with no
    error anywhere. Every field here must stay in Ollama's generated
    `required` array, or NativeOutput mode silently degrades regardless of
    the actual message."""

    response: str
    multi_turn: bool = Field(alias="multiTurn")
    tools_needed: list[str] = Field(alias="toolsNeeded")
    planning_needed: bool = Field(alias="planningNeeded")
    defer_to_growth: bool = Field(alias="deferToGrowth")
    knowledge_gap_topic: str | None = Field(alias="knowledgeGapTopic")
    behavior_feedback_category: str | None = Field(alias="behaviorFeedbackCategory")
    behavior_feedback_note: str | None = Field(alias="behaviorFeedbackNote")
    memorable_items: list[MemorableItemOutput] = Field(alias="memorableItems")
    is_correction: bool = Field(alias="isCorrection")

    model_config = {"populate_by_name": True, "extra": "forbid"}


class BehaviorFeedback(BaseModel):
    category: str
    note: str


class MemorableItem(BaseModel):
    type: str
    content: str


class TurnOutput(BaseModel):
    """Post-processed, invariant-enforced result - what the rest of the
    service actually consumes. `relevant_groups`/`relevant_tools` keep these
    exact names (not `tools_needed`) so the many existing
    `classification.relevant_groups`/`.relevant_tools` references across
    context_builder.py/main.py/safety_net.py don't need to change."""

    response: str
    multi_turn: bool
    relevant_groups: list[str]
    relevant_tools: list[str]
    planning_needed: bool
    defer_to_growth: bool
    knowledge_gap_topic: str | None
    behavior_feedback: BehaviorFeedback | None
    memorable_items: list[MemorableItem]
    is_correction: bool
    explicit_research_request: bool = False


def expand_groups_to_tools(relevant_groups: list[str]) -> list[str]:
    """'calculate' and 'task_context_manage' are always exposed regardless of
    classification - calculate because a classifier miss can't be allowed to
    silently drop arithmetic/date-resolution, and task_context_manage because
    an open cross-session task can be resumed by a message that doesn't
    obviously name any capability at all. 'skill_examples' is always exposed
    too, same reasoning as memory_recall being force-added below - it's a
    drill-in for whichever skill ends up actually bound this turn (Skills v2,
    see skills_discovery.py), not tied to any one category.

    'knowledge_lookup' joined this list for the identical reason calculate
    did: a classifier miss can't be allowed to silently drop it. Live-
    verified twice in one session: "What is the Hermes agent harness
    framework? Tell me its capabilities." and "Is Zanthorax a real
    programming framework?" both classified as groups=['info'] only (a
    category explicitly scoped to facts ABOUT THE USER, not general lookups)
    - with no lookup tool bound at all, the second one answered anyway,
    confidently inventing that "Zanthorax" is a Voltron character. No prompt
    wording fix generalizes across phrasings reliably enough to risk that
    failure mode. Over-binding this on a turn that didn't need it costs
    little now that knowledge_lookup's own per-item content is capped and
    grounding has a deterministic backstop (has_ungrounded_specifics);
    under-binding it on a turn that did need it costs a confidently wrong
    answer with nothing to catch it.

    Only called when multiTurn is true - see _normalize_output, which forces
    relevant_tools to [] on the fast path, which is what lets every
    downstream safety-net check in main.py degrade correctly with zero
    special-casing."""
    tools: set[str] = {"calculate", "task_context_manage", "skill_examples", "knowledge_lookup"}
    for group in relevant_groups:
        for member in GROUPS.get(group, []):
            tools.add(member)
    return list(tools)


async def _call_ollama(ollama_host: str, model: str, system_prompt: str, prompt: str) -> AmyResponseOutput:
    """Single native-API call with thinking disabled and JSON constrained -
    see module docstring for why this stays off the OpenAI-compatible
    endpoint and off thinking mode."""
    schema = AmyResponseOutput.model_json_schema(by_alias=True)
    payload = {
        "model": model,
        "stream": False,
        "think": False,
        "format": schema,
        "options": {"num_predict": _RESPOND_MAX_OUTPUT_TOKENS},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
    }
    async with httpx.AsyncClient(timeout=_RESPOND_TIMEOUT_SECONDS) as client:
        response = await client.post(f"{ollama_host}/api/chat", json=payload)
        response.raise_for_status()
    content = response.json().get("message", {}).get("content", "")
    if not content:
        raise ValueError("Ollama response had no message content")
    return AmyResponseOutput.model_validate_json(content)


def _fallback_result(chat_input: str) -> TurnOutput:
    # Failure degrades to "only calculate/task_context_manage, answer
    # nothing" rather than "all tools, invent an answer" - a hiccup here
    # can't reintroduce the exact large-tool-set failure mode this step
    # exists to avoid, and can't silently fabricate a fast-path answer
    # either, so multi_turn is forced true to let the tool-capable agent
    # call actually produce the reply instead of trusting an empty one.
    explicit_lookup = bool(EXPLICIT_LOOKUP_INTENT.search(chat_input))
    likely_lookup = bool(LIKELY_FACTUAL_QUESTION.search(chat_input)) and not NON_LOOKUP_QUESTION.search(chat_input)
    groups = ["web"] if explicit_lookup or likely_lookup else []
    explicit_research = bool(EXPLICIT_RESEARCH_REQUEST.search(chat_input))
    return TurnOutput(
        response="",
        multi_turn=True,
        relevant_groups=groups,
        relevant_tools=expand_groups_to_tools(groups),
        planning_needed=False,
        defer_to_growth=explicit_research,
        knowledge_gap_topic=None,
        behavior_feedback=None,
        memorable_items=[],
        is_correction=False,
        explicit_research_request=explicit_research,
    )


def _normalize_output(
    parsed: AmyResponseOutput,
    chat_input: str,
    recent_context: str | None,
    open_teaching_session: bool = False,
) -> TurnOutput:
    """Pure, deterministic post-processing - every invariant the schema
    promises is enforced here, not just hoped for from the prompt. No
    network, fully unit-testable."""
    relevant_groups = [g for g in parsed.tools_needed if g in TOOL_GROUPS]
    multi_turn = parsed.multi_turn

    # Deterministic guards below force a group into relevant_groups AND
    # force multi_turn true together, always as a pair - forcing the group
    # alone would be inert: relevant_tools is forced to [] whenever
    # multi_turn is false (below), so a forced group the model itself didn't
    # also flag as needing more work would silently do nothing. Under the
    # old architecture (every turn always ran the tool-capable call
    # regardless of classification) this pairing wasn't needed; it is now.

    # A standing-instruction/teaching cue always gets self-growth,
    # regardless of what other category the model also matched - see
    # STANDING_INSTRUCTION_INTENT's comment above for why this can't just
    # be a prompt reminder.
    if "self-growth" not in relevant_groups and STANDING_INSTRUCTION_INTENT.search(chat_input):
        relevant_groups.append("self-growth")
        multi_turn = True

    # An already-open teaching session (growth_db.get_open_teaching_session)
    # force-binds self-growth the same way - moved here from
    # context_builder.py so the one normalization function owns every
    # deterministic group override, not two.
    if open_teaching_session and "self-growth" not in relevant_groups:
        relevant_groups.append("self-growth")
        multi_turn = True

    explicit_lookup = bool(EXPLICIT_LOOKUP_INTENT.search(chat_input))
    if explicit_lookup and "web" not in relevant_groups:
        relevant_groups.append("web")
        multi_turn = True

    # Narrower than explicit_lookup above - catches a question that reads
    # as needing a live/current check without saying so explicitly (e.g.
    # "what is the latest stable version of X"), which the model's own
    # multiTurn judgment missed live (see NEEDS_CURRENT_INFO_INTENT's
    # comment).
    if NEEDS_CURRENT_INFO_INTENT.search(chat_input) and "web" not in relevant_groups:
        relevant_groups.append("web")
        multi_turn = True

    # No group needed here - calculate is already in
    # expand_groups_to_tools's unconditional baseline, so forcing
    # multi_turn alone is enough to make it reachable.
    if NEEDS_CALCULATION_INTENT.search(chat_input):
        multi_turn = True

    explicit_research = bool(EXPLICIT_RESEARCH_REQUEST.search(chat_input))
    # Forces defer_to_growth regardless of the model's own output - same
    # "don't trust the model to be disciplined" pattern as every guard
    # above. Deliberately NOT paired with multi_turn: deferToGrowth calls
    # straight into growth_db.record_observation server-side (see main.py),
    # independent of whatever this turn's own response/multiTurn is -
    # answering now and separately enqueuing research aren't exclusive.
    defer_to_growth = parsed.defer_to_growth or explicit_research

    # multiTurn=false collapses the whole tool-capable second call away -
    # forcing relevant_tools to [] here (rather than trusting the model to
    # also leave toolsNeeded empty) is what makes every downstream
    # safety-net check in main.py degrade correctly with zero special-
    # casing: has_unfulfilled_search_intent/has_unsatisfied_required_tool
    # naturally return False against an empty bound-tools list,
    # has_unaddressed_teaching_intent can't fire since relevant_groups can
    # only contain self-growth when multi_turn forces it true anyway, and
    # the confabulation/fabricated-id/citation checks still apply exactly
    # as intended since they check the reply against actually-empty
    # called_tools/tool_results.
    relevant_tools = expand_groups_to_tools(relevant_groups) if multi_turn else []

    # Both invariants enforced by coercion, not reject-and-fallback -
    # rejecting the whole call over one bad field wastes the entire
    # response the model already produced.
    planning_needed = bool(parsed.planning_needed and multi_turn and not defer_to_growth)

    # Same "don't trust the model to be disciplined" lesson as above: a
    # correction is inherently about the immediately preceding turn, so
    # it's impossible without one.
    is_correction = bool(parsed.is_correction and recent_context)

    knowledge_gap_topic = (
        parsed.knowledge_gap_topic.strip()
        if parsed.knowledge_gap_topic and parsed.knowledge_gap_topic.strip()
        else None
    )

    behavior_feedback = (
        BehaviorFeedback(category=parsed.behavior_feedback_category, note=parsed.behavior_feedback_note.strip())
        if parsed.behavior_feedback_category in BEHAVIOR_FEEDBACK_CATEGORIES
        and parsed.behavior_feedback_note
        and parsed.behavior_feedback_note.strip()
        else None
    )

    memorable_items = [
        MemorableItem(type=item.type, content=item.content.strip())
        for item in parsed.memorable_items
        if item.type in MEMORABLE_ITEM_TYPES and item.content and item.content.strip()
    ]

    return TurnOutput(
        response=parsed.response,
        multi_turn=multi_turn,
        relevant_groups=relevant_groups,
        relevant_tools=relevant_tools,
        planning_needed=planning_needed,
        defer_to_growth=defer_to_growth,
        knowledge_gap_topic=knowledge_gap_topic,
        behavior_feedback=behavior_feedback,
        memorable_items=memorable_items,
        is_correction=is_correction,
        explicit_research_request=explicit_research,
    )


async def generate_response(
    ollama_host: str,
    model: str,
    chat_input: str,
    system_prompt: str,
    # Last ~10 messages (main.py), not the full session history - enough
    # to resolve an anaphoric follow-up ("fix that", "delete it") and stay
    # consistent with what was just established a turn or two back,
    # without ballooning this call's prompt the way dumping the full
    # history would.
    recent_context: str | None = None,
    open_teaching_session: bool = False,
) -> TurnOutput:
    try:
        prompt = chat_input
        if recent_context:
            prompt = f"Recent conversation (for reference only):\n{recent_context}\n\n{chat_input}"
        parsed = await _call_ollama(ollama_host, model, system_prompt, prompt)
        return _normalize_output(parsed, chat_input, recent_context, open_teaching_session)
    except Exception:
        logger.exception("generate_response failed, falling back to calculate-only, multi_turn=True")
        return _fallback_result(chat_input)
