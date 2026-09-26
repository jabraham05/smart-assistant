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


class GraphNode(BaseModel):
    id: str
    label: str
    summary: str | None = None
    kind: str = "entity"


class GraphEdge(BaseModel):
    source: str
    target: str
    type: str
    fact: str | None = None


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


# Real graph structure for Amy Lab's Knowledge Graph tab - /search above only
# ever returns flattened fact strings, no node/edge IDs or structure at all.
# Live-verified this session against the actual FalkorDriver.save() queries
# graphiti-core runs (graphiti_core.driver.falkordb_driver /
# graphiti_core.models.edges.edge_db_queries): entity nodes always carry the
# `Entity` label plus uuid/name/summary/group_id properties, and every
# relationship is a single generic `RELATES_TO` edge type carrying its own
# specific name/fact/group_id properties - not a per-relationship Cypher
# type. Real, live-verified finding: FalkorDB is multi-tenant at the *graph*
# level, and graphiti-core writes each group_id into its OWN separate
# FalkorDB graph (confirmed via `GRAPH.LIST` showing both "default_db" and
# "smart-assistant") - graphiti.driver.execute_query() always targets
# "default_db" regardless, so a query for real data must select the group's
# own graph via the driver's underlying FalkorDB client instead.
_GRAPH_QUERY = """
MATCH (n:Entity)-[r:RELATES_TO]->(m:Entity)
RETURN n.uuid AS source_id, n.name AS source_name, n.summary AS source_summary,
       m.uuid AS target_id, m.name AS target_name, m.summary AS target_summary,
       r.name AS rel_type, r.fact AS fact
LIMIT $limit
"""


@app.get("/graph", response_model=GraphResponse)
async def get_graph(groupId: str | None = None, limit: int = 200):
    # Hard cap regardless of requested limit - this feeds a visualization,
    # not a bulk export.
    limit = min(limit, 500)
    graph = graphiti.driver.client.select_graph(groupId or config.group_id)
    result = await graph.query(_GRAPH_QUERY, {"limit": limit})
    header = [h[1] for h in result.header]
    records = [dict(zip(header, row)) for row in result.result_set]

    nodes: dict[str, GraphNode] = {}
    edges: list[GraphEdge] = []
    for row in records or []:
        source_id = row["source_id"]
        target_id = row["target_id"]
        if source_id not in nodes:
            nodes[source_id] = GraphNode(id=source_id, label=row["source_name"], summary=row["source_summary"])
        if target_id not in nodes:
            nodes[target_id] = GraphNode(id=target_id, label=row["target_name"], summary=row["target_summary"])
        edges.append(GraphEdge(source=source_id, target=target_id, type=row["rel_type"], fact=row["fact"]))

    return GraphResponse(nodes=list(nodes.values()), edges=edges)


@app.get("/health")
async def health():
    return {"status": "ok"}
