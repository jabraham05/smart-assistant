"""FastAPI wrapper around Graphiti - Phase 3's decision/project/growth
ledger. Amy's own code (event-bus, knowledge-engine) calls POST /episodes
only at meaningful moments - project approved, goal created, project
consolidated - never raw per-turn conversation ingestion. See
graphiti_client.py for why FalkorDB + Ollama, and this project's own
architecture notes for why this stays additive to Honcho/memory-engine
rather than replacing either.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from graphiti_core.nodes import EpisodeType
from pydantic import BaseModel

from .config import load_config
from .graphiti_client import build_graphiti

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

config = load_config()
graphiti = build_graphiti(config)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # One-time schema setup - real, live-verified requirement, not
    # optional: add_episode fails against a fresh FalkorDB instance with no
    # indices/constraints built yet.
    await graphiti.build_indices_and_constraints()
    logger.info("Graphiti indices/constraints ready")
    yield
    await graphiti.close()


app = FastAPI(lifespan=lifespan)


class AddEpisodeRequest(BaseModel):
    name: str
    episodeBody: str
    sourceDescription: str
    referenceTime: str | None = None
    groupId: str | None = None


class AddEpisodeResponse(BaseModel):
    episodeUuid: str
    nodeCount: int
    edgeCount: int
    nodes: list[str]
    facts: list[str]


@app.post("/episodes", response_model=AddEpisodeResponse)
async def add_episode(req: AddEpisodeRequest):
    reference_time = datetime.fromisoformat(req.referenceTime) if req.referenceTime else datetime.now(timezone.utc)
    try:
        result = await graphiti.add_episode(
            name=req.name,
            episode_body=req.episodeBody,
            source_description=req.sourceDescription,
            reference_time=reference_time,
            source=EpisodeType.text,
            group_id=req.groupId or config.group_id,
        )
    except Exception as e:
        # Real, live-verified design stance: episode writes are always
        # fire-and-forget from the caller's side (see event-bus's POST
        # /goals for the established pattern this mirrors) - a slow or
        # failing graphiti-service must never delay or break the actual
        # goal/project/task write it's attached to. Surfacing a 500 here
        # still matters for logs/observability, just never for the
        # caller's own success path.
        logger.exception("add_episode failed for %s", req.name)
        raise HTTPException(status_code=500, detail=str(e)) from e

    return AddEpisodeResponse(
        episodeUuid=result.episode.uuid,
        nodeCount=len(result.nodes),
        edgeCount=len(result.edges),
        nodes=[n.name for n in result.nodes],
        facts=[e.fact for e in result.edges],
    )


class SearchResponse(BaseModel):
    facts: list[str]


@app.get("/search", response_model=SearchResponse)
async def search(query: str, groupId: str | None = None):
    results = await graphiti.search(query, group_ids=[groupId or config.group_id])
    return SearchResponse(facts=[r.fact for r in results])


@app.get("/health")
async def health():
    return {"status": "ok"}
