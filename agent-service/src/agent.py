"""PydanticAI Agent construction + MCP tool binding - the Python equivalent
of chat-orchestrator/src/agent-loop.ts's tool-wiring half (the retry/
NDJSON-streaming half lives in main.py, matching index.ts's split).

Live-verified against the real skills-mcp server (2026-09-24): MCPToolset's
`.filtered()` correctly narrows the full 22-tool catalog down to an exact
per-run subset based on a RunContext-aware predicate - this is what makes
the Coordinator's classified relevant_tools list actually bind only the
relevant tools, the same reliability mitigation classify-tools.ts's
tool-group filtering already proved necessary (qwen3:8b's measured
tool-count reliability cliff: 3/3 success at 1 tool, 0/3 at 6).
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.providers.ollama import OllamaProvider

from .config import Config


@dataclass
class AgentDeps:
    """Per-run dependencies threaded through RunContext - the filter
    predicate reads relevant_tools off this to decide what's bound for
    this specific turn, mirroring index.ts's
    `mcpTools.filter((t) => relevantTools.includes(t.name))`."""

    relevant_tools: list[str]


def build_skills_mcp_toolset(config: Config, session_id: str) -> MCPToolset:
    """Same endpoint and session-correlation query param skills-mcp already
    expects (server.ts's stateless per-request createServer() reads
    req.query.chatSessionId) - zero changes needed to skills-mcp itself.

    filtered()'s predicate signature is (ctx, tool_def) -> bool, confirmed
    live against the real skills-mcp server (2026-09-24): correctly narrowed
    the full 22-tool catalog down to an exact requested subset."""
    url = f"{config.skills_mcp_url}/mcp?chatSessionId={session_id}"
    mcp = MCPToolset(url)
    return mcp.filtered(lambda ctx, tool_def: tool_def.name in ctx.deps.relevant_tools)


def build_agent(config: Config, session_id: str, system_prompt: str) -> Agent[AgentDeps, str]:
    model = OllamaModel(model_name=config.chat_model, provider=OllamaProvider(base_url=f"{config.ollama_host}/v1"))
    toolset = build_skills_mcp_toolset(config, session_id)
    return Agent(
        model,
        deps_type=AgentDeps,
        instructions=system_prompt,
        toolsets=[toolset],
        # Same escalated timeout as chat-orchestrator's postToolTimeoutMs -
        # the post-tool-result synthesis call is disproportionately likely
        # to exceed a short default given a large tool result (the exact
        # mechanism behind the status_overview silence bug fixed in
        # chat-orchestrator this session). PydanticAI doesn't distinguish
        # pre/post-tool iterations at the model_settings level the way the
        # hand-rolled TS loop does, so this applies uniformly - acceptable
        # since it only raises the ceiling, never lowers reliability.
        #
        # Real bug found via live review_turns evidence (a literal "/think"
        # token leaking into a user-visible reply, plus a cluster of
        # persona_alignment complaints about rambling, unconsolidated
        # replies): unlike classify.py and growth_judge.py, this agent
        # never disabled Ollama's thinking mode, and unlike this Python
        # port, the original chat-orchestrator/src/ollama.ts defaulted
        # `think: false` everywhere. This was dropped during the Phase 1
        # PydanticAI port, not an intentional choice - qwen3 defaults
        # thinking ON, and safety-net.ts documents Ollama sometimes
        # dropping tool_calls entirely on a thinking response, so this
        # plausibly cost tool-calling reliability too, not just tone.
        model_settings={"timeout": config.post_tool_timeout_seconds, "thinking": False},
    )
