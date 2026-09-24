"""Direct port of chat-orchestrator/src/memory-engine-client.ts. No LLM
anywhere in this path - classification-derived domain tagging + hybrid RRF
ranking do the work of surfacing the right raw snippets. Degrades to an
empty result rather than throwing, same "briefly-unreachable dependency
shouldn't break the chat" pattern as honcho_client.py.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from .config import Config

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MemorySearchResult:
    content: str
    role: str
    session_id: str
    domain: str | None
    task_context_id: int | None
    created_at: str
    score: float
    # A recency-boosted RRF score alone can't tell a genuine match from an
    # unrelated "best of a bad bunch" - keyword_overlap_count/
    # query_lexeme_count let is_relevant_memory check real lexeme overlap.
    keyword_overlap_count: int
    query_lexeme_count: int


async def search_memory(config: Config, query: str, top_k: int = 5) -> list[MemorySearchResult]:
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{config.memory_engine_url}/search", json={"query": query, "topK": top_k}, timeout=10
            )
            if not res.is_success:
                return []
            results = res.json().get("results") or []
            return [
                MemorySearchResult(
                    content=r["content"],
                    role=r["role"],
                    session_id=r["sessionId"],
                    domain=r.get("domain"),
                    task_context_id=r.get("taskContextId"),
                    created_at=r["createdAt"],
                    score=r["score"],
                    keyword_overlap_count=r["keywordOverlapCount"],
                    query_lexeme_count=r["queryLexemeCount"],
                )
                for r in results
            ]
    except Exception:
        logger.exception("memory-engine search failed")
        return []


def is_relevant_memory(result: MemorySearchResult, min_score: float, min_keyword_overlap: int) -> bool:
    """Same two-signal gate as knowledge-engine's decideRoute(), for the
    same reason - a plain threshold check, not an LLM call. Skips the
    overlap check entirely when the query has no significant lexemes."""
    if result.score < min_score:
        return False
    if result.query_lexeme_count > 0 and result.keyword_overlap_count < min_keyword_overlap:
        return False
    return True


async def ingest_memory(
    config: Config,
    session_id: str,
    role: str,
    content: str,
    domain: str | None = None,
    task_context_id: int | None = None,
) -> None:
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{config.memory_engine_url}/ingest",
                json={
                    "sessionId": session_id,
                    "role": role,
                    "content": content,
                    "domain": domain,
                    "taskContextId": task_context_id,
                },
                timeout=10,
            )
    except Exception:
        logger.exception("memory-engine ingest failed")
