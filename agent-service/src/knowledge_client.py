"""Direct port of chat-orchestrator/src/knowledge-engine-client.ts."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from .config import Config, is_test_session

logger = logging.getLogger(__name__)


async def create_entity_from_chat(
    config: Config, item_type: str, content: str, session_id: str | None = None
) -> None:
    """Promotes a classifier-extracted memorable item (fact/preference/decision/
    learning) or a behavior-feedback capture into a durable `entities` row -
    fire-and-forget, same pattern as enqueue_research_topic above. Dedup/
    validation all happen inside knowledge-engine's own POST /entities; this
    is a thin, fail-silent client.
    """
    if is_test_session(session_id):
        return
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{config.knowledge_engine_url}/entities",
                json={
                    "type": item_type,
                    "name": content[:80],
                    "description": content,
                    "sourceTable": "chat",
                    "sourceId": session_id,
                },
                timeout=10,
            )
    except Exception:
        logger.exception("knowledge-engine entity create failed")


@dataclass(frozen=True)
class OpenProjectSummary:
    id: int
    title: str
    status: str


@dataclass(frozen=True)
class KnowledgeSearchResult:
    content: str
    document_title: str | None
    domain: str | None
    score: float
    keyword_overlap_count: int
    query_lexeme_count: int
    created_at: str | None
    retrieved_at: str | None
    valid_until: str | None
    source_url: str | None
    source_title: str | None


async def search_knowledge(config: Config, query: str, top_k: int = 5) -> list[KnowledgeSearchResult]:
    """Search the durable world-knowledge store; expired documents remain excluded."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{config.knowledge_engine_url}/search",
                json={"query": query, "topK": top_k},
                timeout=10,
            )
            if not res.is_success:
                return []
            return [
                KnowledgeSearchResult(
                    content=r["content"],
                    document_title=r.get("documentTitle"),
                    domain=r.get("domain"),
                    score=float(r.get("score") or 0),
                    keyword_overlap_count=int(r.get("keywordOverlapCount") or 0),
                    query_lexeme_count=int(r.get("queryLexemeCount") or 0),
                    created_at=r.get("createdAt"),
                    retrieved_at=r.get("retrievedAt"),
                    valid_until=r.get("validUntil"),
                    source_url=(r.get("source") or {}).get("url"),
                    source_title=(r.get("source") or {}).get("title"),
                )
                for r in (res.json().get("results") or [])
            ]
    except Exception:
        logger.exception("knowledge-engine search failed")
        return []


def is_relevant_knowledge(result: KnowledgeSearchResult, min_score: float, min_keyword_overlap: int) -> bool:
    if result.score < min_score:
        return False
    return result.query_lexeme_count == 0 or result.keyword_overlap_count >= min_keyword_overlap


async def enqueue_research_brief(config: Config, brief: str, opportunity_id: int) -> bool:
    """Queue a Growth-approved, Planner-scoped brief; queue handles dedup/known checks."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{config.knowledge_engine_url}/research-queue",
                json={
                    "topic": brief,
                    "triggerSource": f"growth_opportunity:{opportunity_id}",
                },
                timeout=15,
            )
            if not res.is_success:
                logger.error("research brief enqueue returned %s: %s", res.status_code, res.text[:500])
                return False
            body = res.json()
            return bool(body.get("queued") or body.get("alreadyKnown") or body.get("existingQueueId"))
    except Exception:
        logger.exception("Growth research brief enqueue failed")
        return False


# Caps how many open projects get injected into the system prompt every
# turn - short, always-on list, not exhaustive.
_MAX_OPEN_PROJECTS_IN_PROMPT = 10


async def list_open_projects(config: Config) -> list[OpenProjectSummary]:
    """Powers the always-on 'already proposed or active projects' line in
    system_prompt.py - lets the model recognize an already-covered idea
    before ever calling project_propose, rather than relying solely on
    knowledge-engine's own title-lexeme-overlap dedup check after the fact."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{config.knowledge_engine_url}/projects", timeout=8)
            if not res.is_success:
                return []
            projects = res.json().get("projects") or []
            open_projects = [p for p in projects if p.get("status") in ("proposed", "active")]
            return [
                OpenProjectSummary(id=p["id"], title=p["title"], status=p["status"])
                for p in open_projects[:_MAX_OPEN_PROJECTS_IN_PROMPT]
            ]
    except Exception:
        logger.exception("list_open_projects failed")
        return []
