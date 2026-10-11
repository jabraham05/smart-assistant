"""Direct port of chat-orchestrator/src/classify-tools.ts's Coordinator
classification step - a raw structured-output call, now via PydanticAI's
Agent(output_type=...) instead of a hand-written JSON-schema `format` dict.
Ported near-unchanged (same category list, same GROUPS mapping, same prompt
text) since this step already bypassed native tool-calling entirely and is
mitigating a real, measured, client-independent qwen3:8b limitation - it
isn't part of what's broken, and PydanticAI's own structured-output
validation/retry (see module docstring in agent.py) only strengthens it.

Verify early: self-hosted Ollama's grammar-constrained response_format/
json_schema needs v0.5.0+ (confirmed present: 0.32.3 at time of writing -
well past this floor) for this Agent's output_type to be enforced reliably
rather than just requested.
"""

from __future__ import annotations

import logging
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_ai import Agent, NativeOutput
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.providers.ollama import OllamaProvider

logger = logging.getLogger(__name__)

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
GROUPS: dict[str, list[str]] = {
    "media": ["spotify_control"],
    "scheduling": ["calendar_event"],
    "info": ["weather_get", "memory_recall"],
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
    "web": ["web_search"],
    "knowledge": ["knowledge_search", "knowledge_ingest"],
    "research": ["research_task", "research_task_status", "status_overview", "project_complete"],
    "goals": ["goal_manage", "project_propose", "status_overview", "project_complete"],
}

BEHAVIOR_FEEDBACK_CATEGORIES = [
    "communication",
    "tool_selection",
    "memory_retrieval",
    "planning",
    "proactivity",
    "other",
]

MEMORABLE_ITEM_TYPES = ["fact", "preference", "decision", "learning"]

_CLASSIFIER_SYSTEM_PROMPT = (
    "Classify which capability categories (zero, one, or a few) might be needed to respond to the "
    "user's message. Categories: 'media' (music/Spotify playback control), 'scheduling' (calendar "
    "events), 'info' (weather, or RECALLING facts/preferences ABOUT THE USER THEMSELVES that Amy "
    "should already know or look up - their traits, likes, past statements, e.g. 'what do you know "
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
    "dashboard), 'web' (searching the live web for current information, news, or facts that could "
    "have changed since training, OR looking something up online in general such as finding "
    "products, links, or recommendations - e.g. 'find me a good pair of headphones', 'give me some "
    "links for X'), 'knowledge' (looking up or searching within a specific document/manual/guide Amy "
    "has stored, or anything else already saved in Amy's knowledge base/past research - e.g. 'do you "
    "have the manual for my car', 'what does the guide say about X', 'look up Y in what we saved', "
    "'what have you already learned about X' where X is a topic and not the user themselves - or "
    "saving a specific web page for later recall), 'research' (starting in-depth background research "
    "on a topic not already known, that should be saved for later, OR checking on/asking about "
    "findings from research that may have already happened - 'what have you found out about X', 'any "
    "updates on the research', 'how's that going' - include 'research' for these EVEN IF X also "
    "matches an existing goal or project; the two aren't mutually exclusive, and research about a "
    "goal's topic is common), 'goals' (creating, listing, updating, or checking progress on the "
    "user's persistent personal objectives - life goals like job search/fitness/savings, but just as "
    "much a new hobby/technical/creative project the user mentions wanting to start or work on, e.g. "
    "'I have a new project idea, I want to build a robotics arm', 'I'm going to learn guitar' - these "
    "classify 'goals' too, not just the traditional life-objective examples). A question about a "
    "specific named document, manual, or guide is always 'knowledge', never 'info' - 'info' is only "
    "for facts about the user as a person, not things Amy has stored. Most messages need none at all "
    "- only include a category if it's genuinely likely needed.\n\n"
    "Also classify four independent policy fields:\n"
    "- toolPolicy: 'required' if answering correctly depends on live/authoritative data or performing "
    "a real action (e.g. anything calendar, weather, goals, Spotify, dashboard, research, or "
    "coding-task related) - the assistant must not guess or answer from memory here. 'optional' for "
    "general conversation, opinions, or facts that don't depend on the user's actual live state.\n"
    "- memoryPolicy: 'none' for a message with no personal relevance at all (a trivia question, small "
    "talk with no follow-up value). 'required' when the user explicitly asks about their own past "
    "statements, preferences, or history ('what did I tell you about X', 'what do you remember about "
    "me'). 'relevant' when personal context would materially improve the answer even though it wasn't "
    "explicitly asked for. 'optional' otherwise (the default for most ordinary conversation).\n"
    "- needsPlanning: true only for a genuinely multi-step request that should be broken into tracked "
    "steps rather than answered in one shot (e.g. 'plan my trip', 'help me reorganize my week around "
    "my calendar'). False for anything answerable or doable in this one turn.\n"
    "- background: true only when the user explicitly wants something done later/in the background "
    "without waiting for it now (e.g. 'look into X overnight and let me know', 'do some deep research "
    "on this and get back to me'). False otherwise, including for normal 'research' requests where the "
    "user is waiting on the reply.\n"
    "- knowledgeGapTopic: a short topic string (a few words) ONLY when the user expresses genuine "
    "ongoing interest in a specific topic/project they want to learn about or work on - something Amy "
    "likely knows little about and should go quietly research in the background, not something to "
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
    "You may also be given the single most recent exchange as brief prior context, labeled 'Prior "
    "exchange (for reference only)'. Use it ONLY to resolve what a vague follow-up refers to (\"fix "
    "that\", \"change it to 11am today\", \"actually make it Tuesday\", \"delete it\") - classify based "
    "on what the user is actually asking for once resolved, not the prior exchange's own content. A "
    "correction to something just scheduled is still 'scheduling'; a correction to a task just "
    "created is still whatever category the task itself was.\n\n"
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


class ClassifierOutput(BaseModel):
    """Mirrors classify-tools.ts's CLASSIFIER_FORMAT JSON schema exactly -
    deliberately NO field defaults. Real, live-verified finding: if every
    field has a Python-side default, Pydantic's auto-generated JSON schema
    omits the `required` array entirely, and Ollama's grammar-constrained
    decoder then lets the model take the always-valid empty-default shortcut
    for relevantGroups instead of being forced to actually classify - a
    silent, always-empty-classification failure with no error anywhere.
    The original TS CLASSIFIER_FORMAT explicitly lists all 8 fields in
    `required`; this must match, or NativeOutput mode silently degrades to
    always-optional/never-classified regardless of the actual message."""

    relevant_groups: list[str] = Field(alias="relevantGroups")
    tool_policy: Literal["required", "optional"] = Field(alias="toolPolicy")
    memory_policy: Literal["none", "optional", "relevant", "required"] = Field(alias="memoryPolicy")
    needs_planning: bool = Field(alias="needsPlanning")
    background: bool
    knowledge_gap_topic: str | None = Field(alias="knowledgeGapTopic")
    behavior_feedback_category: str | None = Field(alias="behaviorFeedbackCategory")
    behavior_feedback_note: str | None = Field(alias="behaviorFeedbackNote")
    memorable_items: list[MemorableItemOutput] = Field(alias="memorableItems")
    is_correction: bool = Field(alias="isCorrection")

    model_config = {"populate_by_name": True}


class BehaviorFeedback(BaseModel):
    category: str
    note: str


class MemorableItem(BaseModel):
    type: str
    content: str


class ClassificationResult(BaseModel):
    relevant_groups: list[str]
    relevant_tools: list[str]
    tool_policy: Literal["required", "optional"]
    memory_policy: Literal["none", "optional", "relevant", "required"]
    needs_planning: bool
    background: bool
    knowledge_gap_topic: str | None
    behavior_feedback: BehaviorFeedback | None
    memorable_items: list[MemorableItem]
    is_correction: bool


def expand_groups_to_tools(relevant_groups: list[str]) -> list[str]:
    """'calculate' and 'task_context_manage' are always exposed regardless of
    classification - calculate because a classifier miss can't be allowed to
    silently drop arithmetic/date-resolution, and task_context_manage because
    an open cross-session task can be resumed by a message that doesn't
    obviously name any capability at all. 'skill_examples' is always exposed
    too, same reasoning as memory_recall being force-added for relevant/
    required memoryPolicy below - it's a drill-in for whichever skill ends
    up actually bound this turn (Skills v2, see skills_discovery.py), not
    tied to any one classifier group."""
    tools: set[str] = {"calculate", "task_context_manage", "skill_examples"}
    for group in relevant_groups:
        for member in GROUPS.get(group, []):
            tools.add(member)
    return list(tools)


def apply_background_override(
    background: bool, relevant_groups: list[str], relevant_tools: list[str]
) -> tuple[bool, list[str]]:
    """Force-expose research_task/research_task_status for a background
    request even if 'research' wasn't classified. A background request about
    something else entirely (Spotify, the calendar) has no generic
    background-any-tool executor, so it silently falls back to the normal
    synchronous path rather than claiming a background mode that can't do
    anything differently."""
    if not background:
        return False, relevant_tools
    has_backgroundable_work = "research" in relevant_groups or "web" in relevant_groups
    if not has_backgroundable_work:
        return False, relevant_tools
    return True, list(dict.fromkeys([*relevant_tools, "research_task", "research_task_status"]))


def _build_classifier_agent(ollama_host: str, model: str) -> Agent[None, ClassifierOutput]:
    return Agent(
        OllamaModel(model_name=model, provider=OllamaProvider(base_url=f"{ollama_host}/v1")),
        # NativeOutput, not PydanticAI's default tool-call-based structured
        # output - a real, live-verified finding: the default mode routes
        # ClassifierOutput through a synthetic "final_result" tool call,
        # which is exactly the qwen3:8b tool-calling reliability cliff this
        # whole classification step exists to avoid (classify-tools.ts's own
        # header comment: "deliberately not native tool-calling, since
        # that's the exact mechanism proven unreliable"). NativeOutput uses
        # Ollama's grammar-constrained response_format/json_schema decoding
        # instead - confirmed working live against qwen3:8b on this
        # project's actual Ollama version (0.32.3).
        output_type=NativeOutput(ClassifierOutput),
        instructions=_CLASSIFIER_SYSTEM_PROMPT,
        # think=False equivalent - qwen3 defaults to thinking-mode ON even
        # when unrequested (a real, measured ~2.9s -> ~0.09s latency finding
        # from the smart-mirror dashboard work), and this call is
        # latency-sensitive since it runs on every single message.
        # Real finding: OpenAIChatModelSettings has a dedicated `thinking`
        # key (bool | reasoning-effort literal) - `extra_body: {"think":
        # False}` (the OpenAI-SDK-style passthrough convention) silently
        # never reached the actual request at all.
        model_settings={"thinking": False, "timeout": 30},
    )


def _fallback_result() -> ClassificationResult:
    # Classifier failure degrades to "only calculate/task_context_manage"
    # rather than "all tools" - a classifier hiccup can't reintroduce the
    # exact large-tool-set failure mode this step exists to avoid.
    return ClassificationResult(
        relevant_groups=[],
        relevant_tools=expand_groups_to_tools([]),
        tool_policy="optional",
        memory_policy="optional",
        needs_planning=False,
        background=False,
        knowledge_gap_topic=None,
        behavior_feedback=None,
        memorable_items=[],
        is_correction=False,
    )


async def classify_relevant_tools(
    ollama_host: str,
    model: str,
    chat_input: str,
    # Last exchange only, not full history - just enough to resolve an
    # anaphoric follow-up ("fix that", "delete it"), kept short since this
    # call runs on every message.
    recent_context: str | None = None,
) -> ClassificationResult:
    try:
        agent = _build_classifier_agent(ollama_host, model)
        prompt = chat_input
        if recent_context:
            prompt = f"Prior exchange (for reference only):\n{recent_context}\n\n{chat_input}"
        result = await agent.run(prompt)
        parsed = result.output

        relevant_groups = [g for g in parsed.relevant_groups if g in TOOL_GROUPS]
        background, tools_after_background = apply_background_override(
            parsed.background, relevant_groups, expand_groups_to_tools(relevant_groups)
        )
        # Force-expose memory_recall for relevant/required memoryPolicy even
        # if 'info' wasn't classified.
        relevant_tools = (
            list(dict.fromkeys([*tools_after_background, "memory_recall"]))
            if parsed.memory_policy in ("relevant", "required")
            else tools_after_background
        )

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

        # Deterministic guard, not just trusting the model: a correction is
        # inherently about the immediately preceding turn, so it's
        # impossible without one - same "don't trust the model to be
        # disciplined when a deterministic constraint can enforce it
        # instead" lesson as calculate.ts/safety-net.ts's tool-policy
        # enforcement.
        is_correction = bool(parsed.is_correction and recent_context)

        return ClassificationResult(
            relevant_groups=relevant_groups,
            relevant_tools=relevant_tools,
            tool_policy=parsed.tool_policy,
            memory_policy=parsed.memory_policy,
            needs_planning=parsed.needs_planning,
            background=background,
            knowledge_gap_topic=knowledge_gap_topic,
            behavior_feedback=behavior_feedback,
            memorable_items=memorable_items,
            is_correction=is_correction,
        )
    except Exception:
        logger.exception("classify_relevant_tools failed, falling back to calculate-only")
        return _fallback_result()
