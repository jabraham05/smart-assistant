"""Python equivalent of chat-orchestrator/src/index.ts - the Python equivalent
of chat-orchestrator/src/index.ts's turn orchestration: classify → assemble
system prompt → run the PydanticAI agent, streamed → apply the safety-net
retries → persist to Honcho/Redis/memory-engine.

Preserves the exact NDJSON wire contract chat-ui/discord-bot already parse
(same {type, content, metadata: {nodeId, nodeName: "AI Agent", ...}} shape) -
this is a hard constraint, not a nice-to-have, since neither client is in
scope for this rebuild phase. Not yet wired into chat-ui/discord-bot's
webhook URL - runs alongside chat-orchestrator until proven via eval-harness
parity + a real soak period (see the plan's Phase 1 checkpoint).
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
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

from . import event_bus_client, honcho_client, knowledge_client, memory_client, session_memory
from .agent import AgentDeps, build_agent
from .classify import classify_relevant_tools
from .config import Config, load_config
from .db import get_active_instruction_skills, get_persona_system_prompt
from .safety_net import (
    FABRICATED_ID_NUDGE,
    REQUIRED_TOOL_FAILURE_MESSAGE,
    REQUIRED_TOOL_RETRY_NUDGE,
    SEARCH_RETRY_NUDGE,
    has_fabricated_id_reference,
    has_unfulfilled_search_intent,
    has_unsatisfied_required_tool,
    is_confabulated_action,
)
from .system_prompt import OpenProject, OpenTask, RelevantGoal, SystemPromptInput, build_system_prompt
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

config = load_config()
app = FastAPI()

# Same literal string chat-ui/discord-bot already key off of - both clients
# only ever treat a type:"item" event with metadata.nodeName:"AI Agent" as
# reply text.
_NODE_NAME = "AI Agent"

# Same cap as chat-orchestrator's own tool-error retry loop.
_MAX_TOOL_ERROR_RETRIES = 3

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


async def _run_turn(
    config: Config,
    session_id: str,
    system_prompt: str,
    user_prompt: str,
    relevant_tools: list[str],
    state: _TurnState,
    emit,
    message_history: list[ModelMessage],
) -> tuple[str, list[str]]:
    """One attempt at a full agent turn - streams NDJSON as it goes,
    returns (final_text, chunks_yielded). Wrapped in try/except so a thrown
    error (timeout, ToolRetryError, UnexpectedModelBehavior - all
    confirmed-real failure modes found via live testing this session)
    degrades to an empty result the caller's existing empty-output retry
    already handles, instead of propagating past the whole safety net -
    the exact bug class fixed in chat-orchestrator this session.

    message_history is the same fixed list across every retry attempt within
    one webhook call - it's what happened BEFORE this turn, so a retry nudge
    on the current turn doesn't change it."""
    state.attempt += 1
    chunks: list[str] = []
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
                        chunks.append(emit("item", event.part.content))
                    elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                        text_parts.append(event.delta.content_delta)
                        chunks.append(emit("item", event.delta.content_delta))
                    elif isinstance(event, FunctionToolCallEvent):
                        tool_name = event.part.tool_name
                        iteration += 1
                        open_tool_calls[event.part.tool_call_id] = (tool_name, iteration)
                        state.called_tools.append(tool_name)
                        chunks.append(
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
                        chunks.append(
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
        return "".join(text_parts), chunks
    except Exception:
        logger.exception("agent turn threw for session %s (attempt %d)", session_id, state.attempt)
        return "", chunks


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

            _t = time.monotonic()
            classification, persona_prompt, active_skills, memory_results, open_tasks, relevant_goals, open_projects = (
                await asyncio.gather(
                    classify_relevant_tools(config.ollama_host, config.classifier_model, chat_input, recent_context),
                    get_persona_system_prompt(config),
                    get_active_instruction_skills(config),
                    memory_client.search_memory(config, chat_input),
                    event_bus_client.match_task_contexts(config, chat_input),
                    event_bus_client.match_goals(config, chat_input),
                    knowledge_client.list_open_projects(config),
                )
            )
            # Real, live-verified finding: this gather's wall time is almost
            # entirely classify_relevant_tools's own LLM call (confirmed via
            # per-task timing during a live profiling session) - every other
            # item here (Postgres/event-bus/knowledge-engine reads, a single
            # memory-engine embedding lookup) finishes in well under half a
            # second. classify and the main reply are the two dominant,
            # unavoidable-per-turn LLM calls on this hardware.
            logger.info("TIMING classify+context-gather session=%s took=%.2fs", session_id, time.monotonic() - _t)

            # Real, live-verified gap: this used to only check needs_planning/
            # background/research/web - a message that classifies purely as
            # self-growth (e.g. "start a coding task to...") never triggered
            # it, even though code_task starts a genuine real async job, the
            # same class of "this is going to take a while" work.
            should_acknowledge = (
                classification.needs_planning
                or classification.background
                or "research" in classification.relevant_groups
                or "web" in classification.relevant_groups
                or "self-growth" in classification.relevant_groups
            )

            if classification.knowledge_gap_topic:
                asyncio.create_task(
                    knowledge_client.enqueue_research_topic(
                        config, classification.knowledge_gap_topic, session_id=session_id
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

            relevant_memory_results = [
                m
                for m in memory_results
                if memory_client.is_relevant_memory(
                    m, config.memory_min_relevance_score, config.memory_min_keyword_overlap
                )
            ] if classification.memory_policy != "none" else []
            relevant_memories = [m.content for m in relevant_memory_results]

            user_card: list[str] = []
            user_card_for_amy: list[str] = []
            if classification.memory_policy != "none":
                _t = time.monotonic()
                if not await session_memory.is_honcho_initialized(config, session_id):
                    await honcho_client.ensure_session_exists(config, session_id)
                    await honcho_client.set_user_observe_config(config, session_id)
                    await session_memory.mark_honcho_initialized(config, session_id)
                user_card, user_card_for_amy = await asyncio.gather(
                    honcho_client.get_user_card(config), honcho_client.get_user_card_for_amy(config)
                )
                logger.info("TIMING honcho session=%s took=%.2fs", session_id, time.monotonic() - _t)

            system_prompt = build_system_prompt(
                SystemPromptInput(
                    persona_system_prompt=persona_prompt or "You are Amy, a helpful personal assistant.",
                    now=datetime.now(timezone.utc),
                    user_card=user_card,
                    user_card_for_amy=user_card_for_amy,
                    skills_catalog_text="\n\n".join(
                        f"## {s.name}\n{s.description}\n\n{s.instructions}" for s in active_skills
                    ),
                    relevant_memories=relevant_memories,
                    open_tasks=[OpenTask(id=t.id, objective=t.objective, status=t.status) for t in open_tasks],
                    relevant_goals=[RelevantGoal(id=g.id, title=g.title, status=g.status) for g in relevant_goals],
                    open_projects=[OpenProject(id=p.id, title=p.title, status=p.status) for p in open_projects],
                    needs_planning_nudge=classification.needs_planning,
                    narrate_before_slow_answer=should_acknowledge,
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
            final_text, chunks = await _run_turn(
                config, session_id, system_prompt, chat_input, classification.relevant_tools, state, emit,
                message_history,
            )
            for c in chunks:
                yield c

            # One-shot empty-output retry - same shape as chat-orchestrator's.
            if not final_text.strip():
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "empty_output"})
                final_text, chunks = await _run_turn(
                    config, session_id, system_prompt, chat_input, classification.relevant_tools, state, emit,
                    message_history,
                )
                for c in chunks:
                    yield c

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
                retry_text, chunks = await _run_turn(
                    config, session_id, system_prompt, retry_prompt, classification.relevant_tools, state, emit,
                    message_history,
                )
                for c in chunks:
                    yield c
                if retry_text.strip():
                    final_text = retry_text

            bound_tools = classification.relevant_tools

            if has_unfulfilled_search_intent(final_text, bound_tools, state.called_tools):
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "search_intent"})
                retry_text, chunks = await _run_turn(
                    config, session_id, system_prompt, chat_input + SEARCH_RETRY_NUDGE, bound_tools, state, emit,
                    message_history,
                )
                for c in chunks:
                    yield c
                if retry_text.strip():
                    final_text = retry_text

            if is_confabulated_action(final_text, bound_tools, state.called_tools):
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "confabulation"})
                nudge = (
                    " (Your last reply claimed to have done something, but no matching tool was actually "
                    "called - either actually call the right tool now, or answer without claiming you did.)"
                )
                retry_text, chunks = await _run_turn(
                    config, session_id, system_prompt, chat_input + nudge, bound_tools, state, emit,
                    message_history,
                )
                for c in chunks:
                    yield c
                if retry_text.strip():
                    final_text = retry_text

            if has_fabricated_id_reference(final_text, state.called_tools, state.tool_results):
                yield emit(
                    "trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "fabricated_id"}
                )
                retry_text, chunks = await _run_turn(
                    config, session_id, system_prompt, chat_input + FABRICATED_ID_NUDGE, bound_tools, state, emit,
                    message_history,
                )
                for c in chunks:
                    yield c
                if retry_text.strip():
                    final_text = retry_text

            if has_unsatisfied_required_tool(
                classification.tool_policy, bound_tools, state.called_tools, classification.relevant_groups
            ):
                yield emit("trace", trace={"kind": "retry", "attempt": state.attempt + 1, "reason": "required_tool"})
                retry_text, chunks = await _run_turn(
                    config,
                    session_id,
                    system_prompt,
                    chat_input + REQUIRED_TOOL_RETRY_NUDGE,
                    bound_tools,
                    state,
                    emit,
                    message_history,
                )
                for c in chunks:
                    yield c
                if retry_text.strip():
                    final_text = retry_text
                if has_unsatisfied_required_tool(
                    classification.tool_policy, bound_tools, state.called_tools, classification.relevant_groups
                ):
                    final_text = REQUIRED_TOOL_FAILURE_MESSAGE

            yield emit("end")
            logger.info("TIMING total-until-end session=%s took=%.2fs", session_id, time.monotonic() - _turn_t0)

            _t = time.monotonic()
            memory_domain = ",".join(classification.relevant_groups) or None
            memory_task_context_id = open_tasks[0].id if open_tasks else None
            await asyncio.gather(
                honcho_client.store_turn(config, session_id, chat_input, final_text),
                session_memory.append_turn(config, session_id, chat_input, final_text),
                memory_client.ingest_memory(config, session_id, "user", chat_input, memory_domain, memory_task_context_id),
                memory_client.ingest_memory(
                    config, session_id, "assistant", final_text, memory_domain, memory_task_context_id
                ),
            )
            logger.info("TIMING post-turn-writes session=%s took=%.2fs", session_id, time.monotonic() - _t)
        except Exception as e:
            logger.exception("chat turn failed for session %s", session_id)
            yield emit("error", str(e))

    return StreamingResponse(stream(), media_type="application/x-ndjson")
