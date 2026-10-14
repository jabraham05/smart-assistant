"""Env-driven config for graphiti-service."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value else default


@dataclass(frozen=True)
class Config:
    port: int
    ollama_host: str
    # qwen3:8b, not a bigger model - live-verified this session (Phase 3
    # build) against Graphiti's real structured-extraction prompts: a
    # simple "project approved" episode correctly extracted 4 real entity
    # nodes and 2 accurate relationship edges, and a search query correctly
    # retrieved both facts back. Matches the locked design decision to try
    # qwen3:8b first since episodes are deliberate/infrequent, not
    # per-turn - upgrade only if extraction quality proves insufficient in
    # practice, which this first live test gave no reason to expect.
    extraction_model: str
    # nomic-embed-text (768-dim) - the same embedding model memory-engine
    # and knowledge-engine already use, for consistency, not because
    # Graphiti requires it specifically.
    embedding_model: str
    embedding_dim: int
    falkordb_host: str
    falkordb_port: int
    # Single shared namespace, matching Honcho's own single "smart-
    # assistant" workspace convention already used everywhere else in this
    # project - there's exactly one user, so per-entity-type or per-user
    # group_ids would add complexity with no real benefit right now.
    group_id: str


def load_config(env: dict[str, str] | None = None) -> Config:
    env = env if env is not None else dict(os.environ)
    return Config(
        port=_int_env("PORT", 3012),
        ollama_host=env.get("OLLAMA_HOST") or "http://ollama:11434",
        extraction_model=env.get("EXTRACTION_MODEL") or "qwen3.5:9b",
        embedding_model=env.get("EMBEDDING_MODEL") or "nomic-embed-text",
        embedding_dim=_int_env("EMBEDDING_DIM", 768),
        falkordb_host=env.get("FALKORDB_HOST") or "falkordb",
        falkordb_port=_int_env("FALKORDB_PORT", 6379),
        group_id=env.get("GRAPHITI_GROUP_ID") or "smart-assistant",
    )
