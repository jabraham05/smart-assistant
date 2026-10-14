"""Env-driven config, same shape and defaults as chat-orchestrator/src/config.ts -
this service runs alongside chat-orchestrator during Phase 1, not in place of it,
so every default here deliberately matches the TypeScript service's own defaults
(same Ollama host, same model, same Postgres/Redis/internal-service URLs) rather
than diverging - the two should be interchangeable except for which port each
listens on.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class PostgresConfig:
    host: str
    port: int
    # Personas/skills live in n8n's own database (the physical tables backing
    # its Data Table feature) - same database chat-orchestrator/coding-orchestrator
    # already read/write directly.
    n8n_database: str
    # The Growth engine's own database (postgres/init/24-create-growth-db.sql) -
    # same one-database-per-concern convention as n8n_database above.
    growth_database: str
    # skills-mcp's own database (skill_proposals) - Growth's consolidation
    # step (Phase 6.5) routes 'tool' category proposals here, reusing the
    # existing human-review queue instead of inventing a parallel one.
    skills_database: str
    user: str
    password: str


@dataclass(frozen=True)
class RedisConfig:
    host: str
    port: int
    # 0 for the production instance, 1 for the test instance - keeps session
    # buffers from colliding between the two, matching chat-orchestrator's
    # own REDIS_DB convention exactly.
    db: int


@dataclass(frozen=True)
class Config:
    port: int
    ollama_host: str
    chat_model: str
    classifier_model: str
    # An 8b judge is a documented reliability risk for reflective-reasoning
    # tasks in this project (see docs/growth-engine.md) - the Growth
    # engine's judge (Phase 6.4) uses the bigger model already pulled on
    # this stack's Ollama instance, same choice 96a56acd's own design made.
    growth_judge_model: str
    agent_max_iterations: int
    num_ctx: int
    # Timeout (seconds) for the model call on any agent-loop iteration after
    # a tool has already been called this turn - mirrors chat-orchestrator's
    # postToolTimeoutMs, since PydanticAI's own httpx-based Ollama client
    # still needs an explicit, generous timeout for the post-tool synthesis
    # call (the exact call that produced the silent-timeout bug fixed in
    # chat-orchestrator this session).
    post_tool_timeout_seconds: float
    skills_mcp_url: str
    # Real SKILL.md files (https://agentskills.io/specification) live here,
    # one directory per skill - a dedicated Docker volume
    # (skills-library-data), not inside the repo, since these are runtime-
    # generated artifacts like postgres-data, not source code.
    skills_library_path: str
    postgres: PostgresConfig
    # 'public' (the real views onto n8n's live Data Tables) for production,
    # 'chat_test' for the side-by-side test instance - same convention as
    # chat-orchestrator's dbSchema.
    db_schema: str
    redis: RedisConfig
    honcho_api_key: str | None
    honcho_workspace_id: str
    event_bus_url: str
    memory_engine_url: str
    knowledge_engine_url: str
    # Growth engine follow-up: episodes for meaningful lifecycle moments
    # (proposed/consolidated, not every raw observation) - same "fire an
    # episode at a meaningful moment, not every event" convention
    # event-bus/knowledge-engine already use. Not previously wired into
    # agent-service at all (only coding-orchestrator had this URL).
    graphiti_service_url: str
    memory_min_relevance_score: float
    memory_min_keyword_overlap: int


def _int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value else default


def _float_env(name: str, default: float) -> float:
    value = os.environ.get(name)
    return float(value) if value else default


def load_config(env: dict[str, str] | None = None) -> Config:
    env = env if env is not None else dict(os.environ)

    postgres_password = env.get("POSTGRES_PASSWORD")
    if not postgres_password:
        raise RuntimeError("POSTGRES_PASSWORD is required")

    return Config(
        port=_int_env("PORT", 3010),
        ollama_host=env.get("OLLAMA_HOST") or "http://ollama:11434",
        # qwen3:8b and qwen3:14b were both retired - qwen3.5:9b is now the
        # only model pulled, for every role (chat, classifier, Growth
        # judge). qwen3.5:9b matched or beat qwen3:14b on live benchmarking
        # (see scripts/benchmark-results/, including a real
        # execution-verified agentic task), and consolidating onto one
        # model everywhere eliminates the VRAM-swap cost between two
        # differently-sized models that didn't both fit in 12GB at once -
        # see growth_judge.py's _unload_model, which now only actually
        # unloads when growth_judge_model differs from chat_model.
        chat_model=env.get("CHAT_MODEL") or "qwen3.5:9b",
        classifier_model=env.get("CHAT_CLASSIFIER_MODEL") or "qwen3.5:9b",
        growth_judge_model=env.get("GROWTH_JUDGE_MODEL") or "qwen3.5:9b",
        agent_max_iterations=_int_env("CHAT_AGENT_MAX_ITERATIONS", 10),
        num_ctx=_int_env("CHAT_NUM_CTX", 16384),
        post_tool_timeout_seconds=_float_env("CHAT_POST_TOOL_TIMEOUT_SECONDS", 120.0),
        skills_mcp_url=env.get("SKILLS_MCP_URL") or "http://skills-mcp:3001",
        skills_library_path=env.get("SKILLS_LIBRARY_PATH") or "/data/skills",
        postgres=PostgresConfig(
            host=env.get("POSTGRES_HOST") or "postgres",
            port=_int_env("POSTGRES_PORT", 5432),
            n8n_database=env.get("N8N_DB_NAME") or "n8n",
            growth_database=env.get("GROWTH_DB_NAME") or "growth",
            skills_database=env.get("SKILLS_DB_NAME") or "skills",
            user=env.get("POSTGRES_USER") or "assistant",
            password=postgres_password,
        ),
        db_schema=env.get("CHAT_DB_SCHEMA") or "public",
        redis=RedisConfig(
            host=env.get("REDIS_HOST") or "redis",
            port=_int_env("REDIS_PORT", 6379),
            db=_int_env("REDIS_DB", 0),
        ),
        honcho_api_key=env.get("HONCHO_API_KEY") or None,
        honcho_workspace_id=env.get("HONCHO_WORKSPACE_ID") or "smart-assistant",
        event_bus_url=env.get("EVENT_BUS_URL") or "http://event-bus:3004",
        memory_engine_url=env.get("MEMORY_ENGINE_URL") or "http://memory-engine:3007",
        knowledge_engine_url=env.get("KNOWLEDGE_ENGINE_URL") or "http://knowledge-engine:3005",
        graphiti_service_url=env.get("GRAPHITI_SERVICE_URL") or "http://graphiti-service:3012",
        # Same default value as knowledge-engine's routeToWebThreshold - both
        # are RRF scores from the identical k=60 formula.
        memory_min_relevance_score=_float_env("MEMORY_MIN_RELEVANCE_SCORE", 0.012),
        memory_min_keyword_overlap=_int_env("MEMORY_MIN_KEYWORD_OVERLAP", 1),
    )
