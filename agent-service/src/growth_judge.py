"""Growth engine Phase 6.4: the shared judge. One prompt, reused by both the
live review sweep (growth_background.py) and the golden-transcript
regression check below - the old self-improvement pipeline (96a56acd)
extracted this into its own n8n sub-workflow specifically so the two could
never diverge in wording; here that just means "one function, two
callers."

Structured output via PydanticAI's Agent(output_type=NativeOutput(...)),
same pattern classify.py already uses and already proved reliable against
this stack's Ollama - not a raw hand-parsed JSON call. Runs on the bigger
qwen3:14b model (config.growth_judge_model), not the 8b model the live
chat/classifier turns use: an 8b judge is a documented reliability risk for
reflective-reasoning tasks in this project.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Literal

import httpx
from pydantic import BaseModel, Field
from pydantic_ai import Agent, NativeOutput
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.providers.ollama import OllamaProvider

from . import growth_db
from .config import Config

logger = logging.getLogger(__name__)

_JUDGE_SYSTEM_PROMPT = (
    "You are reviewing one exchange between a user and Amy, a personal AI assistant, to help Amy "
    "improve over time. Score five independent dimensions, each 1-5 (5 is best): taskSuccess (did "
    "Amy's reply actually accomplish what the user needed), relevance (did it address what was "
    "actually asked), personaAlignment (did Amy's tone/behavior match a helpful, direct personal "
    "assistant - not sycophantic, not robotic, no reflexive stock phrases), userSentiment (did the "
    "user seem satisfied, frustrated, or neutral based on their own words), followupCoherence (if "
    "there's a follow-up message, did Amy's reply make sense in light of it - e.g. did Amy actually "
    "stop doing something the user just asked it to stop doing).\n\n"
    "Then list EVERY distinct root cause you can identify for any score below 4 - a single symptom "
    "can have more than one independent cause; do not stop at the first plausible explanation. Each "
    "attribution needs a type (persona_text: Amy's own system-prompt instructions caused this; "
    "honcho_peer_card: a stored behavioral instruction about Amy caused this; "
    "model_capability_limitation: the underlying model just got something wrong unrelated to "
    "instructions; tool_failure: a tool call failed or wasn't made when it should have been; "
    "ambiguous_user_request: the user's own message was genuinely unclear; none: nothing worth "
    "flagging), a confidence from 0 to 1, evidence (quote the actual transcript), and an optional "
    "suggestedFixArea (a short phrase naming what should change). If every score is 4 or 5, return "
    "a single attribution with type 'none', confidence 1, evidence 'no issues found', and a null "
    "suggestedFixArea.\n\n"
    "flaggedForHuman: true only for something a human should look at directly (e.g. a safety "
    "concern, a repeated severe failure) - false for ordinary scoring.\n"
    "overallNotes: one or two sentences summarizing the exchange's quality."
)


class JudgeAttributionOutput(BaseModel):
    type: Literal[
        "persona_text", "honcho_peer_card", "model_capability_limitation", "tool_failure",
        "ambiguous_user_request", "none",
    ]
    confidence: float
    evidence: str
    suggested_fix_area: str | None = Field(alias="suggestedFixArea")

    model_config = {"populate_by_name": True}


class JudgeOutput(BaseModel):
    # Deliberately no field defaults - same reasoning as classify.py's
    # ClassifierOutput: a default lets Ollama's grammar-constrained decoder
    # take an always-valid shortcut instead of actually scoring.
    task_success: int = Field(alias="taskSuccess")
    relevance: int
    persona_alignment: int = Field(alias="personaAlignment")
    user_sentiment: int = Field(alias="userSentiment")
    followup_coherence: int = Field(alias="followupCoherence")
    overall_notes: str = Field(alias="overallNotes")
    flagged_for_human: bool = Field(alias="flaggedForHuman")
    attributions: list[JudgeAttributionOutput]

    model_config = {"populate_by_name": True}


def _build_judge_agent(config: Config) -> Agent[None, JudgeOutput]:
    return Agent(
        OllamaModel(
            model_name=config.growth_judge_model, provider=OllamaProvider(base_url=f"{config.ollama_host}/v1")
        ),
        output_type=NativeOutput(JudgeOutput),
        instructions=_JUDGE_SYSTEM_PROMPT,
        model_settings={"thinking": False, "timeout": 90},
    )


async def _unload_model(config: Config, model: str) -> None:
    """Explicit immediate-unload via Ollama's native keep_alive:0 convention.

    PydanticAI's OllamaModel has no model_settings field for keep_alive (grepped
    the installed package, no hit) - unlike `thinking`, it was never special-
    cased for pass-through. The server-wide OLLAMA_KEEP_ALIVE=-1 in
    docker-compose.yml means this bigger qwen3:14b judge model, once loaded,
    would otherwise pin itself in VRAM forever, evicting the live chat model
    with nothing to ever give that VRAM back (the same ratchet documented on
    coding-orchestrator's ollama.ts keepAlive option). Best-effort: a failure
    here just means the model stays resident a bit longer, not a real error.
    """
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{config.ollama_host}/api/chat",
                json={"model": model, "messages": [], "keep_alive": 0},
                timeout=10,
            )
    except Exception:
        logger.debug("growth_judge._unload_model best-effort unload failed", exc_info=True)


async def run_judge(config: Config, transcript: str) -> JudgeOutput | None:
    try:
        agent = _build_judge_agent(config)
        result = await agent.run(transcript)
        return result.output
    except Exception:
        logger.exception("growth_judge.run_judge failed")
        return None
    finally:
        await _unload_model(config, config.growth_judge_model)


def format_transcript(turns: list[dict]) -> str:
    """review_turns rows (user_message/agent_reply pairs, in order) ->
    plain User:/Amy: text, same shape golden_transcripts already store."""
    lines = []
    for t in turns:
        lines.append(f"User: {t['user_message']}")
        lines.append(f"Amy: {t['agent_reply']}")
    return "\n".join(lines)


async def _ollama_chat(config: Config, model: str, messages: list[dict], timeout: float = 60.0) -> str:
    """Real, live-verified finding (2026-10-10): the OpenAI-compatible
    /v1/chat/completions endpoint silently ignores Ollama's "think" field -
    a call with think=False took the same ~60s as one without it, both
    well over this function's timeout, while the exact same prompt against
    the native /api/chat endpoint with think=False returned in ~2s. This is
    the same thinking-mode gap agent.py had (qwen3 defaults thinking ON),
    just hitting an endpoint that can't be told to turn it off - unlike
    _build_judge_agent's PydanticAI OllamaModel, which goes through the
    native API under the hood and already disables it correctly. Switching
    endpoints is the fix, not raising the timeout further.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{config.ollama_host}/api/chat",
            json={"model": model, "messages": messages, "stream": False, "think": False},
            timeout=timeout,
        )
        resp.raise_for_status()
        return resp.json()["message"]["content"]


def _extract_user_turns(transcript: str) -> list[str]:
    return [line[len("User: "):] for line in transcript.split("\n") if line.startswith("User: ")]


async def _regenerate_transcript(config: Config, persona_system_prompt: str, user_turns: list[str]) -> str:
    """Replays a golden transcript's user turns as a plain, non-tool chat
    completion against a given persona - golden transcripts are ordinary
    conversation with no tool calls expected, so the full PydanticAI
    tool-calling agent loop isn't needed for this simulation."""
    messages: list[dict] = [{"role": "system", "content": persona_system_prompt}]
    lines: list[str] = []
    for turn in user_turns:
        messages.append({"role": "user", "content": turn})
        reply = await _ollama_chat(config, config.chat_model, messages)
        messages.append({"role": "assistant", "content": reply})
        lines.append(f"User: {turn}")
        lines.append(f"Amy: {reply}")
    return "\n".join(lines)


_SCORE_FIELD_MAP = {
    "task_success_score": "task_success",
    "relevance_score": "relevance",
    "persona_alignment_score": "persona_alignment",
    "user_sentiment_score": "user_sentiment",
    "followup_coherence_score": "followup_coherence",
}


class SkillEvaluationOutput(BaseModel):
    # No field defaults - same reasoning as JudgeOutput/ClassifierOutput.
    effectiveness_score: int = Field(alias="effectivenessScore")
    reasoning: str

    model_config = {"populate_by_name": True}


_SKILL_EVAL_SYSTEM_PROMPT = (
    "You are evaluating a proposed skill (a written procedure Amy, a personal AI assistant, would "
    "follow) against real evidence of a recurring problem it's meant to address. Score "
    "effectivenessScore 1-5: would a reasonable assistant, actually following these instructions, "
    "plausibly have prevented or fixed the problem shown in the evidence? 1 means the instructions "
    "are irrelevant or would not have helped; 5 means they directly and clearly address the root "
    "cause. Be skeptical of vague instructions that restate the problem without giving a concrete "
    "procedure. reasoning: one or two sentences justifying the score."
)


def _build_skill_eval_agent(config: Config) -> Agent[None, SkillEvaluationOutput]:
    return Agent(
        OllamaModel(
            model_name=config.growth_judge_model, provider=OllamaProvider(base_url=f"{config.ollama_host}/v1")
        ),
        output_type=NativeOutput(SkillEvaluationOutput),
        instructions=_SKILL_EVAL_SYSTEM_PROMPT,
        # Real timeout found live-testing against genuinely long captured
        # teaching content under real concurrent load: 60s consistently
        # wasn't enough. 120s matches post_tool_timeout_seconds's existing
        # ceiling for the same class of "judge call needs more time" problem.
        model_settings={"thinking": False, "timeout": 120},
    )


# Below this score, the skill still gets written (the human already
# approved it via growth_review - this is informational, not a block, same
# pattern as the behavior/regression check never auto-blocking either) but
# the consolidated skill's `reason` gets a loud warning prefix instead of
# silently looking as sound as a high-scoring one.
SKILL_EFFECTIVENESS_PASS_THRESHOLD = 4


async def evaluate_skill_plausibility(config: Config, evidence_text: str, draft_instructions: str) -> SkillEvaluationOutput | None:
    """Phase 6.4, skill category: the before/after check skill proposals
    were missing. Not a full baseline-vs-candidate behavioral simulation
    (there's no lightweight way to re-run a real agent turn with a
    hypothetical new skill without reimplementing the whole chat flow) -
    instead, a judge-based plausibility check against the actual evidence
    that produced the opportunity. Still a real evaluation with a real
    recorded score, not a rubber stamp."""
    try:
        agent = _build_skill_eval_agent(config)
        prompt = f"Evidence of the recurring problem:\n{evidence_text}\n\nProposed skill instructions:\n{draft_instructions}"
        result = await agent.run(prompt)
        return result.output
    except Exception:
        logger.exception("growth_judge.evaluate_skill_plausibility failed")
        return None
    finally:
        await _unload_model(config, config.growth_judge_model)


async def check_golden_regression(config: Config, current_persona: str, candidate_persona: str) -> list[dict]:
    """Phase 6.4: before any 'behavior' proposal gets consolidated into a
    persona edit (Phase 6.5), replay every golden transcript's user turns
    against both the current and candidate persona, judge each regenerated
    exchange, and flag a regression if the candidate scores worse than
    either the transcript's own expected_min_scores bar or the current
    persona's actual baseline on that transcript - a fix for one failure
    mode must not silently regress another. Returns one result dict per
    golden transcript; never raises (a judge/regenerate failure for one
    transcript just skips it rather than aborting the whole check)."""
    candidate_hash = hashlib.md5(candidate_persona.encode("utf-8")).hexdigest()
    transcripts = await growth_db.list_golden_transcripts(config)
    results: list[dict] = []
    for gt in transcripts:
        try:
            user_turns = _extract_user_turns(gt["transcript"])
            if not user_turns:
                continue
            expected_min = gt["expected_min_scores"]
            if isinstance(expected_min, str):
                expected_min = json.loads(expected_min) if expected_min else {}
            expected_min = expected_min or {}

            baseline_transcript = await _regenerate_transcript(config, current_persona, user_turns)
            candidate_transcript = await _regenerate_transcript(config, candidate_persona, user_turns)
            baseline_judge = await run_judge(config, baseline_transcript)
            candidate_judge = await run_judge(config, candidate_transcript)
            if baseline_judge is None or candidate_judge is None:
                continue

            baseline_scores = {k: getattr(baseline_judge, v) for k, v in _SCORE_FIELD_MAP.items()}
            candidate_scores = {k: getattr(candidate_judge, v) for k, v in _SCORE_FIELD_MAP.items()}
            regressed = any(
                candidate_scores[k] < expected_min.get(k, 1) or candidate_scores[k] < baseline_scores[k]
                for k in _SCORE_FIELD_MAP
            )

            await growth_db.record_golden_regression_run(
                config, gt["id"], candidate_hash, baseline_scores, candidate_scores, regressed
            )
            results.append(
                {"label": gt["label"], "regressed": regressed, "baseline": baseline_scores, "candidate": candidate_scores}
            )
        except Exception:
            logger.exception("growth_judge.check_golden_regression failed for transcript %s", gt.get("label"))
    return results


class TeachingClassificationOutput(BaseModel):
    # No field defaults - same reasoning as JudgeOutput/ClassifierOutput:
    # a missing field should be a visible error, not a silently-wrong guess.
    category: Literal["knowledge", "skill", "behavior", "tool"]
    reasoning: str
    procedure: str | None = Field(alias="procedure")
    rules: str | None = Field(alias="rules")
    examples: str | None = Field(alias="examples")
    open_questions: str | None = Field(alias="openQuestions")
    # Only populated for category='skill' - a skill is now written as a
    # real SKILL.md file (https://agentskills.io/specification), which
    # needs a proper short name (slugified by the caller) and a real
    # discovery description, not the truncated raw captured text that
    # used to get dumped into both fields.
    skill_name: str | None = Field(alias="skillName")
    discovery_description: str | None = Field(alias="discoveryDescription")

    model_config = {"populate_by_name": True}


_TEACHING_CLASSIFY_SYSTEM_PROMPT = (
    "The user has been teaching Amy, a personal AI assistant, something directly - by demonstrating a "
    "task, correcting her attempts at it, or explaining a procedure/rules/examples outright. You're "
    "given the raw captured content of that teaching. Decide what kind of lesson this actually is - "
    "not everything taught should become a new skill:\n"
    "- 'skill': a genuinely repeatable PROCEDURE for doing a task - concrete steps, decision rules, or "
    "a workflow Amy could follow again for a similar request later.\n"
    "- 'behavior': how the user wants Amy to BEHAVE or communicate in general (tone, when to ask vs. "
    "act, a standing preference) - not tied to one specific task's steps.\n"
    "- 'knowledge': a fact, decision, or piece of information to remember - not a procedure to follow.\n"
    "- 'tool': the user is describing a capability/integration Amy doesn't have at all yet (not a "
    "procedure using tools she already has).\n"
    "When genuinely ambiguous, prefer 'knowledge' over inventing a procedure that wasn't really given.\n"
    "If category is 'skill', extract: procedure (the concrete steps, as Amy should follow them), rules "
    "(any decision rules, constraints, or things to always/never do), examples (concrete input/output "
    "examples if any were given, else null), openQuestions (anything genuinely ambiguous or "
    "underspecified that a human should resolve before this is trusted, else null), skillName (a short "
    "2-5 word name for this skill, e.g. 'Vague Goal Planning' or 'Database Troubleshooting' - will be "
    "slugified, so just write it naturally), discoveryDescription (one or two sentences describing both "
    "WHAT this skill does and WHEN to use it - specific enough that another agent could decide from "
    "this alone whether it applies to a given request, e.g. 'Turns a vague goal into a concrete plan "
    "by asking about constraints first. Use when the user states an ambiguous goal without a clear "
    "next step.'). For any other category, leave procedure/rules/examples/openQuestions/skillName/"
    "discoveryDescription null. reasoning: one or two sentences explaining the category choice."
)


def _build_teaching_classify_agent(config: Config) -> Agent[None, TeachingClassificationOutput]:
    return Agent(
        OllamaModel(
            model_name=config.growth_judge_model, provider=OllamaProvider(base_url=f"{config.ollama_host}/v1")
        ),
        output_type=NativeOutput(TeachingClassificationOutput),
        instructions=_TEACHING_CLASSIFY_SYSTEM_PROMPT,
        # Real timeout found live-testing against genuinely long captured
        # teaching content under real concurrent load: 60s consistently
        # wasn't enough. 120s matches post_tool_timeout_seconds's existing
        # ceiling for the same class of "judge call needs more time" problem.
        model_settings={"thinking": False, "timeout": 120},
    )


async def classify_teaching_content(config: Config, mode: str, captured_content: str) -> TeachingClassificationOutput | None:
    """Phase 10.3: classify before building anything. Runs on the bigger
    judge model (not the live chat/classifier's 8b model) for the same
    reliability reason every other reflective-reasoning call in this file
    does - this decision determines whether a lesson becomes a skill, a
    persona-behavior proposal, or a knowledge entry, so a cheap model
    guessing wrong here is a real misclassification, not just a worse
    answer."""
    try:
        agent = _build_teaching_classify_agent(config)
        prompt = f"Teaching mode: {mode}\n\nCaptured content:\n{captured_content}"
        result = await agent.run(prompt)
        return result.output
    except Exception:
        logger.exception("growth_judge.classify_teaching_content failed")
        return None
    finally:
        await _unload_model(config, config.growth_judge_model)
