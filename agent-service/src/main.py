"""Python equivalent of chat-orchestrator/src/index.ts - the Python equivalent
of chat-orchestrator/src/index.ts's turn orchestration: classify → assemble
system prompt → run the PydanticAI agent, streamed → apply the safety-net
retries → persist to Honcho/Redis/memory-engine.

Preserves the exact NDJSON wire contract chat-ui/discord-bot already parse
(same {type, content, metadata: {nodeId, nodeName: "AI Agent", ...}} shape) -
this is a hard constraint, not a nice-to-have, since neither client is in
scope for this rebuild phase. Live: chat-ui/discord-bot's webhook URL points
here now (docker-compose.yml), after eval-harness parity + a real soak
period. chat-orchestrator is left running unmodified as the instant
rollback - see docs/unified-architecture-gap-analysis.md.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelMessage,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
)

from . import (
    context_builder,
    event_bus_client,
    growth_background,
    growth_db,
    growth_routes,
    honcho_client,
    knowledge_client,
    memory_client,
    profile_routes,
    session_memory,
)
from .agent import AgentDeps, build_agent
from .detached_stream import detach
from .config import Config, load_config
from .safety_net import (
    FABRICATED_ID_NUDGE,
    REQUIRED_TOOL_FAILURE_MESSAGE,
    REQUIRED_TOOL_RETRY_NUDGE,
    SEARCH_RETRY_NUDGE,
    UNGROUNDED_CITATION_FAILURE_MESSAGE,
    STATUS_NARRATION_MISMATCH_NUDGE,
    TOOL_FAILURE_NARRATION_NUDGE,
    TRAILING_CONFIRMATION_RETRY_NUDGE,
    UNGROUNDED_CITATION_NUDGE,
    UNWARRANTED_CHECKING_OPENER_NUDGE,
    UNGROUNDED_SPECIFICS_FAILURE_MESSAGE,
    UNGROUNDED_SPECIFICS_NUDGE,
    classify_memory_grounding,
    has_fabricated_id_reference,
    has_status_narration_mismatch,
    has_tool_failure_narration,
    has_trailing_confirmation_question,
    has_unaddressed_teaching_intent,
    has_unfulfilled_search_intent,
    has_ungrounded_citation,
    has_ungrounded_specifics,
    has_unsatisfied_required_tool,
    has_unwarranted_checking_opener,
    is_confabulated_action,
    strip_emoji,
    strip_known_stock_closers,
    teaching_intent_retry_nudge,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

config = load_config()
app = FastAPI()
app.include_router(growth_routes.build_router(config))
app.include_router(profile_routes.build_router(config))


@app.on_event("startup")
async def _start_growth_background_loop() -> None:
    # Phase 9: the autonomous Growth loop - periodically judges unreviewed
    # review_turns and feeds actionable attributions into opportunity
    # scoring. Fire-and-forget: a crash in the loop body is caught inside
    # growth_background itself and must never take down the webhook.
    asyncio.create_task(growth_background.start_background_loop(config))

# Same literal string chat-ui/discord-bot already key off of - both clients
# only ever treat a type:"item" event with metadata.nodeName:"AI Agent" as
# reply text.
_NODE_NAME = "AI Agent"

# Same cap as chat-orchestrator's own tool-error retry loop.
_MAX_TOOL_ERROR_RETRIES = 3

# Lower than _MAX_TOOL_ERROR_RETRIES - a model that narrates "I'll check X"
# instead of actually calling the tool is refusing to call it, not hitting a
# transient failure a few more attempts would plausibly fix. Two real
# chances, then an honest "couldn't complete this" beats shipping the same
# dead-end narration a third time.
_MAX_SEARCH_INTENT_RETRIES = 2
_MAX_UNGROUNDED_SPECIFICS_RETRIES = 2

# Real, live-verified finding: asking the model to narrate before a slow
# tool-heavy turn (system_prompt.py's narrate_line) does not work - tracing
# a real web-search turn showed the stream going straight from the classify
# trace to a tool_call event with zero preceding text, despite the prompt
# nudge. A deterministic, server-emitted acknowledgment (this pool) is used
# instead of relying on the model to comply - see should_acknowledge below.
_ACK_PHRASES = [
    "Let me look into that.",
    "One sec, I'll check on that.",
    "Give me a moment to dig into this.",
    "I'll get started on that now.",
    "Let me pull that together for you.",
    "Working on it — one moment.",
]


@dataclass
class _TurnState:
    """Mutable state threaded through one turn's retry attempts - mirrors
    index.ts's calledTools/lastToolResultRef closures."""

    attempt: int = 0
    called_tools: list[str] = field(default_factory=list)
    last_tool_error: tuple[str, str] | None = None  # (tool_name, error_text)
    # Real (non-error) tool result text, accumulated across every attempt of
    # this turn - lets has_fabricated_id_reference check what a status/
    # lookup tool actually returned against what the reply claims it did.
    tool_results: list[str] = field(default_factory=list)


def _emit(item_index: list[int]):
    def emitter(event_type: str, content: str | None = None, trace: dict | None = None) -> str:
        event = {
            "type": event_type,
            **({"content": content} if content is not None else {}),
            **({"trace": trace} if trace is not None else {}),
            "metadata": {
                "nodeId": "agent-service",
                "nodeName": _NODE_NAME,
                "itemIndex": item_index[0],
                "runIndex": 0,
                "timestamp": int(time.time() * 1000),
            },
        }
        item_index[0] += 1
        return json.dumps(event) + "\n"

    return emitter


@dataclass
class _Attempt:
    """What one streamed attempt produced, filled in by _run_turn."""

    text: str = ""


async def _run_turn(
    config: Config,
    session_id: str,
    system_prompt: str,
    user_prompt: str,
    relevant_tools: list[str],
    state: _TurnState,
    emit,
    message_history: list[ModelMessage],
    out: _Attempt,
) -> AsyncIterator[str]:
    """One attempt at a full agent turn - yields each NDJSON event the
    moment the model produces it, and records the attempt's final text on
    `out`. (It used to collect every chunk and hand them back only once the
    attempt finished, so replies arrived in one burst instead of
    streaming.) Wrapped in try/except so a thrown
    error (timeout, ToolRetryError, UnexpectedModelBehavior - all
    confirmed-real failure modes found via live testing this session)
    degrades to an empty result the caller's existing empty-output retry
    already handles, instead of propagating past the whole safety net -
    the exact bug class fixed in chat-orchestrator this session.

    message_history is the same fixed list across every retry attempt within
    one webhook call - it's what happened BEFORE this turn, so a retry nudge
    on the current turn doesn't change it."""
    state.attempt += 1
    text_parts: list[str] = []
    open_tool_calls: dict[str, tuple[str, int]] = {}  # tool_call_id -> (tool_name, iteration)
    iteration = 0
    _turn_started = time.monotonic()

    try:
        agent = build_agent(config, session_id, system_prompt)
        async with agent:
            async with agent.run_stream_events(
                user_prompt, deps=AgentDeps(relevant_tools=relevant_tools), message_history=message_history
            ) as stream:
                async for event in stream:
                    # Real, live-verified finding: PartDeltaEvent only ever
                    # carries INCREMENTAL updates to an already-started part.
                    # The first chunk of a new text part - including its
                    # entire initial content, not just one character -
                    # arrives on PartStartEvent instead. Handling only
                    # PartDeltaEvent silently dropped that first chunk from
                    # every single response (reproduced 100% consistently
                    # across repeated identical requests - "PHASE1TEST" came
                    # back as "ASE1TEST" every time, never once correct).
                    if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart) and event.part.content:
                        text_parts.append(event.part.content)
                        yield emit("item", event.part.content)
                    elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                        text_parts.append(event.delta.content_delta)
                        yield emit("item", event.delta.content_delta)
                    elif isinstance(event, FunctionToolCallEvent):
                        tool_name = event.part.tool_name
                        iteration += 1
                        open_tool_calls[event.part.tool_call_id] = (tool_name, iteration)
                        state.called_tools.append(tool_name)
                        yield (
                            emit(
                                "trace",
                                trace={
                                    "kind": "tool_call",
                                    "attempt": state.attempt,
                                    # Real, live-verified finding: chat-ui's
                                    # ChatTraceEvent type requires this field
                                    # (a leftover from chat-orchestrator's old
                                    # hand-rolled agent loop, which tracked
                                    # iterations explicitly) - PydanticAI has
                                    # no equivalent counter exposed, so this
                                    # is a simple per-attempt tool-call
                                    # sequence number instead. Missing it
                                    # entirely (as this port originally did)
                                    # left every tool call/result keyed
                                    # `${attempt}:undefined:${name}` client-
                                    # side, silently conflating repeat calls
                                    # to the same tool within one attempt.
                                    "iteration": iteration,
                                    "name": tool_name,
                                    "args": event.part.args_as_dict() if hasattr(event.part, "args_as_dict") else {},
                                },
                            )
                        )
                    elif isinstance(event, FunctionToolResultEvent):
                        # Real, live-verified finding: event.content is always
                        # None on this event - the actual result lives on
                        # event.part (a ToolReturnPart on success, a
                        # RetryPromptPart on a tool-level error/validation
                        # failure).
                        tool_name, result_iteration = getattr(event.part, "tool_name", None), None
                        if not tool_name:
                            tool_name, result_iteration = open_tool_calls.get(event.part.tool_call_id, ("", 0))
                        else:
                            _, result_iteration = open_tool_calls.get(event.part.tool_call_id, (tool_name, 0))
                        is_error = type(event.part).__name__ == "RetryPromptPart"
                        result_text = str(event.part.content)
                        if is_error:
                            state.last_tool_error = (tool_name, result_text)
                        else:
                            state.last_tool_error = None
                            state.tool_results.append(result_text)
                        yield (
                            emit(
                                "trace",
                                trace={
                                    "kind": "tool_result",
                                    "attempt": state.attempt,
                                    "iteration": result_iteration,
                                    "name": tool_name,
                                    "result": result_text[:4000],
                                    "isError": is_error,
                                },
                            )
                        )
        logger.info(
            "TIMING _run_turn session=%s attempt=%d took=%.2fs tool_calls=%d",
            session_id,
            state.attempt,
            time.monotonic() - _turn_started,
            iteration,
        )
        out.text = "".join(text_parts)
    except Exception:
        logger.exception("agent turn threw for session %s (attempt %d)", session_id, state.attempt)
        out.text = ""


@app.post("/webhook")
async def webhook(request: Request):
    body = await request.json()
    chat_input = body.get("chatInput")
    session_id = body.get("sessionId")
    if not chat_input or not session_id:
        return {"error": "chatInput and sessionId are required"}, 400

    async def stream():
        item_index = [0]
        emit = _emit(item_index)

        _turn_t0 = time.monotonic()
        try:
            full_history = await session_memory.get_recent_history(config, session_id)
            message_history = session_memory.to_model_messages(full_history)
            recent_context = None
            if full_history:
                last_two = full_history[-2:]
                recent_context = "\n".join(f"{m.role}: {m.content}" for m in last_two)

            # Growth engine Phase 8: the parallel gather + Honcho card fetch
            # + skill discovery + system-prompt assembly that used to be
            # inlined here now lives in context_builder.py - a pure
            # relocation (same calls, same order, same log lines), not a
            # behavior change. See that module's docstring for why side
            # effects below stay here instead of moving with it.
            ctx = await context_builder.build_context(config, session_id, chat_input, recent_context)
            classification = ctx.classification
            persona_prompt = ctx.persona_prompt
            open_tasks = ctx.open_tasks
            relevant_goals = ctx.relevant_goals
            relevant_memory_results = ctx.relevant_memory_results
            relevant_knowledge_results = ctx.relevant_knowledge_results
            user_card = ctx.user_card
            user_card_for_amy = ctx.user_card_for_amy
            system_prompt = ctx.system_prompt
            should_acknowledge = ctx.should_acknowledge

            if classification.knowledge_gap_topic:
                # A conversational gap is evidence for Growth, not by itself
                # authorization for ambient research. Growth decides after
                # recurrence/value scoring, then Planner scopes any task.
                asyncio.create_task(
                    growth_db.record_observation(
                        config,
                        "knowledge_gap",
                        classification.knowledge_gap_topic,
                        {
                            "chatInput": chat_input,
                            "injectedKnowledge": [k.content[:500] for k in relevant_knowledge_results],
                        },
                        session_id=session_id,
                    )
                )

            if classification.behavior_feedback:
                asyncio.create_task(
                    event_bus_client.publish_behavior_feedback(
                        config,
                        session_id,
                        classification.behavior_feedback.category,
                        classification.behavior_feedback.note,
                    )
                )
                # Promotes the already-captured signal into a visible,
                # durable entity (Growth tab) instead of only logging to
                # event-bus, where nothing reads it automatically yet.
                asyncio.create_task(
                    knowledge_client.create_entity_from_chat(
                        config,
                        "learning",
                        f"{classification.behavior_feedback.category}: {classification.behavior_feedback.note}",
                        session_id=session_id,
                    )
                )
                # Growth engine Phase 6.2/6.3: the same signal also
                # accumulates toward a scored Growth opportunity, classified
                # per its own sub-category (see growth_db.classify_category) -
                # a repeated 'tool_selection' complaint should surface as a
                # tool/skill opportunity, not a behavior one.
                asyncio.create_task(
                    growth_db.record_observation(
                        config,
                        "behavior_feedback",
                        classification.behavior_feedback.note,
                        {"category": classification.behavior_feedback.category, "chatInput": chat_input},
                        session_id=session_id,
                        category=growth_db.classify_category(
                            "behavior_feedback", classification.behavior_feedback.category
                        ),
                    )
                )

            for item in classification.memorable_items:
                asyncio.create_task(
                    knowledge_client.create_entity_from_chat(config, item.type, item.content, session_id=session_id)
                )

            if classification.is_correction:
                # Growth engine: the "user corrections" signal the roadmap
                # named but was never actually captured - classify.py
                # deliberately excludes a single-turn correction from
                # behaviorFeedback (that's for a repeated pattern), so this
                # is the first time it becomes a real Growth observation.
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "user_correction", chat_input, {"chatInput": chat_input}, session_id=session_id
                    )
                )

            yield emit(
                "trace",
                trace={
                    "kind": "classify",
                    "boundTools": classification.relevant_tools,
                    "relevantGroups": classification.relevant_groups,
                    "toolPolicy": classification.tool_policy,
                    "memoryPolicy": classification.memory_policy,
                    "needsPlanning": classification.needs_planning,
                    "background": classification.background,
                    # Real, live-verified finding: chat-ui's ChatTraceEvent type
                    # (and TurnDebugPanel's ClassifyRow, which unconditionally
                    # calls .length on all three) declares these as REQUIRED
                    # fields, matching chat-orchestrator's original emission -
                    # this Python port dropped them, so every classify trace
                    # from agent-service was missing them entirely. TypeScript's
                    # type only checks at compile time; at runtime this crashed
                    # the whole debug panel with "Cannot read properties of
                    # undefined (reading 'length')" the instant a user clicked
                    # any message to see turn detail.
                    "openTasks": [{"id": t.id, "objective": t.objective, "status": t.status} for t in open_tasks],
                    "relevantGoals": [{"id": g.id, "title": g.title, "status": g.status} for g in relevant_goals],
                    "memories": [
                        {"content": m.content, "domain": m.domain, "score": m.score} for m in relevant_memory_results
                    ],
                    "knowledge": [
                        {
                            "content": k.content,
                            "documentTitle": k.document_title,
                            "domain": k.domain,
                            "score": k.score,
                            "sourceUrl": k.source_url,
                        }
                        for k in relevant_knowledge_results
                    ],
                },
            )
            yield emit("begin")

            # Real, live-verified finding: the prompt-level narrate nudge
            # above doesn't get followed - qwen3:8b jumps straight to a tool
            # call with zero preceding text, even when asked to narrate
            # first. This is a deterministic, server-emitted acknowledgment
            # instead, gated on the exact same should_acknowledge signal so
            # a fast/simple turn ("what's 2+2") never gets one - only turns
            # that actually need planning, background work, research, web
            # search, or a coding task do. Emitted as its own "ack" event
            # type (not "item") so discord-bot can send it as an immediate,
            # separate message instead of folding it into the final one
            # (discord-bot buffers the whole stream into a single message
            # otherwise - an ack folded into "item" content would provide
            # zero perceived-latency benefit there). The trailing blank line
            # matters for chat-ui, which concatenates every item/ack chunk
            # into one paragraph - without it the ack would run straight
            # into the model's first sentence with no break.
            if should_acknowledge:
                yield emit("ack", random.choice(_ACK_PHRASES) + "\n\n")

            state = _TurnState()
            _attempt = _Attempt()
            async for c in _run_turn(
                config, session_id, system_prompt, chat_input, classification.relevant_tools, state, emit,
                message_history,
                _attempt,
            ):
                yield c
            final_text = _attempt.text

            # One-shot empty-output retry - same shape as chat-orchestrator's.
            if not final_text.strip():
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "empty_output"})
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input, classification.relevant_tools, state, emit,
                    message_history,
                    _attempt,
                ):
                    yield c
                final_text = _attempt.text

            if not final_text.strip():
                final_text = "No response was generated for that message — try asking again."

            # Deterministic tool-error retry, up to a small cap.
            retries = 0
            while state.last_tool_error and retries < _MAX_TOOL_ERROR_RETRIES:
                tool_name, error_text = state.last_tool_error
                retries += 1
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "tool_error"})
                retry_prompt = (
                    f'{chat_input} (Your last "{tool_name}" call failed: {error_text} — diagnose the cause, '
                    "make the minimal necessary change, and call it again right now before replying. "
                    "Don't just say you'll check again later.)"
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, retry_prompt, classification.relevant_tools, state, emit,
                    message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text

            bound_tools = classification.relevant_tools

            # Capped loop, not one-shot (same shape as the tool-error retry
            # above) - real, observed gap: a single retry gives the model
            # one chance to actually call the tool, but a model that
            # narrates "I'll check X" instead of calling it can just as
            # easily do the exact same thing again on the retry (confirmed
            # live: "I'll check `knowledge_search` on 'Hermes agent harness
            # architecture 2026'..." shipped to the user as the entire final
            # reply, with no further retry attempted). Looping gives it a
            # second real chance; if it still won't call the tool after
            # that, ship an honest "couldn't complete this" instead of the
            # same dead-end narration a third time.
            search_intent_retries = 0
            while (
                has_unfulfilled_search_intent(final_text, bound_tools, state.called_tools)
                and search_intent_retries < _MAX_SEARCH_INTENT_RETRIES
            ):
                search_intent_retries += 1
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure", "Reply implied a search without calling a search tool",
                        {"reason": "search_intent", "chatInput": chat_input}, session_id=session_id,
                    )
                )
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "search_intent"})
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input + SEARCH_RETRY_NUDGE, bound_tools, state, emit,
                    message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text

            if has_unfulfilled_search_intent(final_text, bound_tools, state.called_tools):
                final_text = (
                    "I wasn't able to actually complete a search for that just now, sir - rather than guess, "
                    "ask me again and I'll try again."
                )

            injected_evidence = [
                *(m.content for m in relevant_memory_results),
                *(
                    f"{k.document_title or ''} {k.source_title or ''} {k.source_url or ''}\n{k.content}"
                    for k in relevant_knowledge_results
                ),
            ]
            citation_evidence = [chat_input, *injected_evidence]
            if has_ungrounded_citation(final_text, state.called_tools, state.tool_results, citation_evidence):
                asyncio.create_task(
                    growth_db.record_observation(
                        config,
                        "safety_net_failure",
                        "Reply included a URL absent from retrieved sources",
                        {"reason": "ungrounded_citation", "chatInput": chat_input},
                        session_id=session_id,
                    )
                )
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "ungrounded_citation"}
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input + UNGROUNDED_CITATION_NUDGE, bound_tools,
                    state, emit, message_history, _attempt,
                ):
                    yield c
                if _attempt.text.strip():
                    final_text = _attempt.text
                if has_ungrounded_citation(final_text, state.called_tools, state.tool_results, citation_evidence):
                    final_text = UNGROUNDED_CITATION_FAILURE_MESSAGE

            ungrounded_retries = 0
            while (
                has_ungrounded_specifics(final_text, state.called_tools, state.tool_results, injected_evidence)
                and ungrounded_retries < _MAX_UNGROUNDED_SPECIFICS_RETRIES
            ):
                ungrounded_retries += 1
                asyncio.create_task(
                    growth_db.record_observation(
                        config,
                        "safety_net_failure",
                        "Reply added specific details absent from retrieved evidence",
                        {"reason": "ungrounded_specifics", "chatInput": chat_input},
                        session_id=session_id,
                    )
                )
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "ungrounded_specifics"}
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input + UNGROUNDED_SPECIFICS_NUDGE, bound_tools,
                    state, emit, message_history, _attempt,
                ):
                    yield c
                if _attempt.text.strip():
                    final_text = _attempt.text

            if has_ungrounded_specifics(final_text, state.called_tools, state.tool_results, injected_evidence):
                final_text = UNGROUNDED_SPECIFICS_FAILURE_MESSAGE

            if is_confabulated_action(final_text, bound_tools, state.called_tools):
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure", "Reply claimed an action was taken without calling a tool",
                        {"reason": "confabulation", "chatInput": chat_input}, session_id=session_id,
                    )
                )
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "confabulation"})
                nudge = (
                    " (Your last reply claimed to have done something, but no matching tool was actually "
                    "called - either actually call the right tool now, or answer without claiming you did.)"
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input + nudge, bound_tools, state, emit,
                    message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text

            if has_fabricated_id_reference(final_text, state.called_tools, state.tool_results):
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure", "Reply referenced an id not present in any real tool result",
                        {"reason": "fabricated_id", "chatInput": chat_input}, session_id=session_id,
                    )
                )
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "fabricated_id"}
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input + FABRICATED_ID_NUDGE, bound_tools, state, emit,
                    message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text

            if has_ungrounded_citation(final_text, state.tool_results):
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure", "Reply cited a URL/source not present in any real tool result",
                        {"reason": "ungrounded_citation", "chatInput": chat_input}, session_id=session_id,
                    )
                )
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "ungrounded_citation"}
                )
                retry_text, chunks = await _run_turn(
                    config, session_id, system_prompt, chat_input + UNGROUNDED_CITATION_NUDGE, bound_tools,
                    state, emit, message_history,
                )
                for c in chunks:
                    yield c
                if retry_text.strip():
                    final_text = retry_text

            if has_status_narration_mismatch(final_text, state.called_tools, state.tool_results):
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure", "Reply's narration didn't match what a status/lookup tool actually returned",
                        {"reason": "status_narration_mismatch", "chatInput": chat_input}, session_id=session_id,
                    )
                )
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "status_narration_mismatch"}
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input + STATUS_NARRATION_MISMATCH_NUDGE, bound_tools,
                    state, emit, message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text

            if has_unwarranted_checking_opener(final_text, state.called_tools):
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure", "Reply opened with a checking-now acknowledgment but called no tool",
                        {"reason": "unwarranted_checking_opener", "chatInput": chat_input}, session_id=session_id,
                    )
                )
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "unwarranted_checking_opener"}
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input + UNWARRANTED_CHECKING_OPENER_NUDGE, bound_tools,
                    state, emit, message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text

            if has_tool_failure_narration(final_text, state.called_tools):
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure", "Reply told the user a tool call of ours failed",
                        {"reason": "tool_failure_narration", "chatInput": chat_input}, session_id=session_id,
                    )
                )
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "tool_failure_narration"}
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input + TOOL_FAILURE_NARRATION_NUDGE, bound_tools,
                    state, emit, message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text

            if has_unsatisfied_required_tool(
                classification.tool_policy, bound_tools, state.called_tools, classification.relevant_groups
            ):
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure", "A required tool for this message's category was never called",
                        {"reason": "required_tool", "chatInput": chat_input, "relevantGroups": classification.relevant_groups},
                        session_id=session_id,
                    )
                )
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "required_tool"})
                _attempt = _Attempt()
                async for c in _run_turn(
                    config,
                    session_id,
                    system_prompt,
                    chat_input + REQUIRED_TOOL_RETRY_NUDGE,
                    bound_tools,
                    state,
                    emit,
                    message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text
                if has_unsatisfied_required_tool(
                    classification.tool_policy, bound_tools, state.called_tools, classification.relevant_groups
                ):
                    final_text = REQUIRED_TOOL_FAILURE_MESSAGE

            if has_unaddressed_teaching_intent(chat_input, classification.relevant_groups, state.called_tools):
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure",
                        "Reply promised to follow a standing instruction without calling teaching_session_manage",
                        {"reason": "unaddressed_teaching_intent", "chatInput": chat_input}, session_id=session_id,
                    )
                )
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "unaddressed_teaching_intent"}
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config, session_id, system_prompt, chat_input + teaching_intent_retry_nudge(chat_input),
                    bound_tools, state, emit, message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text

            if has_trailing_confirmation_question(final_text, classification.tool_policy):
                asyncio.create_task(
                    growth_db.record_observation(
                        config, "safety_net_failure", "Reply tacked on a stock trailing confirmation question",
                        {"reason": "trailing_confirmation", "chatInput": chat_input}, session_id=session_id,
                    )
                )
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "trailing_confirmation"}
                )
                _attempt = _Attempt()
                async for c in _run_turn(
                    config,
                    session_id,
                    system_prompt,
                    chat_input + TRAILING_CONFIRMATION_RETRY_NUDGE,
                    bound_tools,
                    state,
                    emit,
                    message_history,
                    _attempt,
                ):
                    yield c
                retry_text = _attempt.text
                if retry_text.strip():
                    final_text = retry_text

            # Deterministic tone backstop - runs after every retry above
            # (including the trailing-confirmation one) has settled, since
            # every attempt's raw chunks were already streamed to the client
            # live (see _run_turn's yields) - fixing final_text alone
            # would only clean what gets stored, not what the user already
            # saw. Reuses the exact mechanism chat-ui's message-reducer
            # already has for a real retry (resets displayed content on a
            # trace kind="retry" event) to correct the visible reply too -
            # only emitted when stripping actually changed something, so a
            # clean turn emits nothing extra.
            cleaned_text = strip_known_stock_closers(strip_emoji(final_text))
            if cleaned_text != final_text:
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "tone_backstop"})
                yield emit("item", cleaned_text)
                final_text = cleaned_text

            yield emit("end")
            logger.info("TIMING total-until-end session=%s took=%.2fs", session_id, time.monotonic() - _turn_t0)

            _t = time.monotonic()
            memory_domain = ",".join(classification.relevant_groups) or None
            memory_task_context_id = open_tasks[0].id if open_tasks else None
            await asyncio.gather(
                honcho_client.store_turn(config, session_id, chat_input, final_text),
                session_memory.append_turn(config, session_id, chat_input, final_text),
                memory_client.ingest_memory(
                    config,
                    session_id,
                    "user",
                    chat_input,
                    memory_domain,
                    memory_task_context_id,
                    grounding=classify_memory_grounding("user", state.called_tools),
                ),
                memory_client.ingest_memory(
                    config,
                    session_id,
                    "assistant",
                    final_text,
                    memory_domain,
                    memory_task_context_id,
                    grounding=classify_memory_grounding("assistant", state.called_tools),
                ),
                # Growth engine Phase 6.1 raw capture - see growth_db.py.
                # Snapshots the persona's own text (not the fully-assembled
                # system_prompt with date/cards/skills baked in), matching
                # what the ported review_turns schema expects to diff
                # against over time.
                growth_db.log_review_turn(
                    config,
                    session_id,
                    persona_prompt or "You are Amy, a helpful personal assistant.",
                    chat_input,
                    final_text,
                    state.called_tools,
                    user_card,
                    user_card_for_amy,
                    config.chat_model,
                ),
            )
            logger.info("TIMING post-turn-writes session=%s took=%.2fs", session_id, time.monotonic() - _t)
        except Exception as e:
            logger.exception("chat turn failed for session %s", session_id)
            yield emit("error", str(e))

    # Detached: the turn (and its post-turn writes) runs to completion even
    # if the client disconnects mid-reply - see detached_stream.py.
    return StreamingResponse(detach(stream(), name=f"chat-turn:{session_id}"), media_type="application/x-ndjson")
