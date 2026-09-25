"""Env-driven config for openhands-runner. Mirrors coding-orchestrator's
own config.ts naming where the same concept exists (ollamaHost, coderModel)
even though the model choice differs - see coder_model's own comment."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value else default


def _float_env(name: str, default: float) -> float:
    value = os.environ.get(name)
    return float(value) if value else default


@dataclass(frozen=True)
class Config:
    port: int
    ollama_host: str
    coder_model: str
    max_attempts: int
    # Same isolation network sandbox-runner's own spawned containers join -
    # never assistant-net, no route to postgres/n8n/ollama's *management*
    # port/Honcho. Reachable at http://ollama:11434 only because ollama
    # itself is also attached to sandbox-net for this reason (see
    # docker-compose.yml) - same pattern sandbox-runner's own executor uses.
    sandbox_network: str
    # Set ONLY on this service, never on coding-orchestrator or any other -
    # same deliberate isolation sandbox-runner's own GITHUB_TOKEN handling
    # uses (see its README: "n8n persists every workflow execution's full
    # node inputs/outputs in Postgres in plaintext"). Never forwarded into
    # the agent's own sandboxed container or visible to its tool calls -
    # only this service's own driver code (task_runner.py) ever reads it,
    # for the exact duration of one clone and one push.
    github_token: str | None
    health_check_timeout: float
    # Real, live-verified finding: `git commit` refuses to run at all
    # without a configured author identity ("Please tell me who you are"),
    # and the spawned agent-server container has none by default - same
    # defaults coding-orchestrator's own config.ts already uses for this
    # exact purpose.
    git_author_name: str
    git_author_email: str


def load_config(env: dict[str, str] | None = None) -> Config:
    env = env if env is not None else dict(os.environ)
    return Config(
        port=_int_env("PORT", 3011),
        ollama_host=env.get("OLLAMA_HOST") or "http://ollama:11434",
        # qwen2.5-coder:7b (coding-orchestrator's original coder model)
        # confirmed live, this session, to fail structurally with OpenHands -
        # it describes tool calls as prose instead of invoking them
        # (rejecting reasoning_effort entirely, and even with reasoning
        # disabled, never emits a real structured call). qwen3:8b - this
        # project's own already-established reliable tool-calling model -
        # confirmed live, this session, to make real, correctly-executed
        # tool calls end-to-end in this exact environment.
        coder_model=env.get("CODER_MODEL") or "qwen3:8b",
        max_attempts=_int_env("MAX_ATTEMPTS", 3),
        sandbox_network=env.get("SANDBOX_NETWORK") or "sandbox-net",
        github_token=env.get("GITHUB_TOKEN") or None,
        health_check_timeout=_float_env("HEALTH_CHECK_TIMEOUT", 180.0),
        git_author_name=env.get("GIT_AUTHOR_NAME") or "smart-assistant-bot",
        git_author_email=env.get("GIT_AUTHOR_EMAIL") or "smart-assistant-bot@users.noreply.github.com",
    )
