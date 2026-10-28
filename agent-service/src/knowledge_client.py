"""Direct port of chat-orchestrator/src/knowledge-engine-client.ts."""

from __future__ import annotations

import asyncio
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
class PreferenceEntity:
    id: str
    content: str


# Real, live-verified gap (2026-10-27 context-assembly audit): open projects
# used to be injected into every single turn regardless of topic - confirmed
# live across a full test battery (projects=4 on every turn, including a
# plain "hey" and a totally unrelated "what is the fermi paradox"), and is
# exactly what made Amy randomly reference an unrelated open project during
# an unconnected conversation. Same deliberate-weak-match philosophy as
# event-bus's task-context/goal matching (minOverlap=1, see
# event-bus/src/db.ts's matchOpenTaskContextsToText): plain lowercase word
# overlap, no stemming, no embeddings - generous enough that an explicit but
# loosely-worded reference still matches, strict enough that an unrelated
# turn gets zero projects instead of all of them.
_OVERLAP_STOPWORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "from", "into", "about",
    "your", "you", "are", "was", "were", "has", "have", "had", "not",
    "what", "when", "where", "how", "why", "can", "will", "would", "could",
})
_PROJECT_MATCH_MIN_OVERLAP = 1


def _overlap_words(text: str) -> set[str]:
    return {
        w for w in "".join(c if c.isalnum() else " " for c in text.lower()).split()
        if len(w) >= 3 and w not in _OVERLAP_STOPWORDS
    }


def _text_overlap_count(chat_input: str, candidate_text: str) -> int:
    return len(_overlap_words(chat_input) & _overlap_words(candidate_text))


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


# Caps how many relevance-matched projects get injected per turn - a real
# limit now that matching can return more than a handful, not a vestige of
# the old always-inject-everything behavior.
_MAX_OPEN_PROJECTS_IN_PROMPT = 10


async def list_open_projects(config: Config, chat_input: str) -> list[OpenProjectSummary]:
    """Powers the 'already proposed or active projects' line in
    system_prompt.py - lets the model recognize an already-covered idea
    before ever calling project_propose, rather than relying solely on
    knowledge-engine's own title-lexeme-overlap dedup check after the fact.

    2026-10-27: relevance-filtered against `chat_input`, not unconditional.
    See `_text_overlap_count` above for why (confirmed-live bug: every
    project rendered on every turn regardless of topic)."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{config.knowledge_engine_url}/projects", timeout=8)
            if not res.is_success:
                return []
            projects = res.json().get("projects") or []
            open_projects = [p for p in projects if p.get("status") in ("proposed", "active")]
            matched = [
                p for p in open_projects
                if _text_overlap_count(chat_input, f"{p.get('title', '')} {p.get('description', '')}")
                >= _PROJECT_MATCH_MIN_OVERLAP
            ]
            return [
                OpenProjectSummary(id=p["id"], title=p["title"], status=p["status"])
                for p in matched[:_MAX_OPEN_PROJECTS_IN_PROMPT]
            ]
    except Exception:
        logger.exception("list_open_projects failed")
        return []


_PREFERENCE_ENTITY_TYPES = ("preference", "user_fact")
_MAX_PREFERENCE_ENTITIES_IN_PROMPT = 10


async def list_preference_entities(config: Config, chat_input: str) -> list[PreferenceEntity]:
    """Phase 3 of the 2026-10-27 context-assembly fix: durable preferences/
    facts (`create_entity_from_chat` above, fed by `memorableItems`) were
    write-only before this - nothing anywhere ever read `entities` back
    into a later turn's prompt. Confirmed live: raw memory-engine recall
    was quietly covering for this gap as an unintentional fallback, not a
    real substitute (it has no concept of "this is a stable, durable fact,
    don't let it decay/dedup away" the way a dedicated entity does).
    Additive, not a replacement - memory-engine recall is untouched.

    Same relevance-gate shape as `list_open_projects` above (generous
    word-overlap, not an exact match) since preference/fact entities are
    expected to be few, same reasoning as goals/tasks: retrieved only when
    actually relevant, not dumped in unconditionally."""
    try:
        async with httpx.AsyncClient() as client:
            responses = await asyncio.gather(
                *[
                    client.get(f"{config.knowledge_engine_url}/entities", params={"type": t}, timeout=8)
                    for t in _PREFERENCE_ENTITY_TYPES
                ],
                return_exceptions=True,
            )
        candidates = []
        for res in responses:
            if isinstance(res, Exception) or not res.is_success:
                continue
            candidates.extend(res.json().get("entities") or [])
        matched = [
            e for e in candidates
            if _text_overlap_count(chat_input, f"{e.get('name', '')} {e.get('description', '')}")
            >= _PROJECT_MATCH_MIN_OVERLAP
        ]
        return [
            PreferenceEntity(id=e["id"], content=e.get("description") or e.get("name") or "")
            for e in matched[:_MAX_PREFERENCE_ENTITIES_IN_PROMPT]
        ]
    except Exception:
        logger.exception("list_preference_entities failed")
        return []
