"""Builds the real Graphiti client - live-verified this session (Phase 3
build) against the actual running stack before this code was written:
FalkorDB (not Neo4j - too heavy for this machine's already-documented
resource contention; not Kuzu - confirmed live via a real deprecation
warning surfaced by graphiti-core itself: "the upstream Kuzu project is no
longer maintained, migrate to Neo4j or FalkorDB") + Ollama for LLM
extraction, embeddings, and reranking, all via Ollama's OpenAI-compatible
endpoint.

Real, live-verified finding: Graphiti's own constructor defaults to
building an OpenAIRerankerClient with no config, which requires a real
OPENAI_API_KEY unless a cross_encoder is passed explicitly - omitting it
crashes at construction time with "Missing credentials," not at first
use. Passed explicitly below, pointed at Ollama like everything else.
"""

from __future__ import annotations

from graphiti_core import Graphiti
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
from graphiti_core.driver.falkordb_driver import FalkorDriver
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client import LLMConfig, OpenAIClient

from .config import Config


def build_graphiti(config: Config) -> Graphiti:
    driver = FalkorDriver(host=config.falkordb_host, port=config.falkordb_port)

    llm_config = LLMConfig(
        api_key="ollama",
        model=config.extraction_model,
        small_model=config.extraction_model,
        base_url=f"{config.ollama_host}/v1",
    )
    llm_client = OpenAIClient(config=llm_config)
    embedder = OpenAIEmbedder(
        config=OpenAIEmbedderConfig(
            api_key="ollama",
            embedding_model=config.embedding_model,
            embedding_dim=config.embedding_dim,
            base_url=f"{config.ollama_host}/v1",
        )
    )
    cross_encoder = OpenAIRerankerClient(config=llm_config)

    return Graphiti(graph_driver=driver, llm_client=llm_client, embedder=embedder, cross_encoder=cross_encoder)
