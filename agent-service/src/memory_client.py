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

from .config import Config, is_test_session

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
    # 'tool_verified' | 'user_stated' | 'ungrounded' - see
    # safety_net.classify_memory_grounding. Defaults to the conservative
    # 'ungrounded' if memory-engine ever omits it (shouldn't happen post-
    # migration, but never trust-by-default on a missing field).
    grounding: str = "ungrounded"


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
                    grounding=r.get("grounding", "ungrounded"),
                )
                for r in results
            ]
    except Exception:
        logger.exception("memory-engine search failed")
        return []


# Real, live-measured gap (2026-10-28): a count-based overlap floor can't
# distinguish a genuine match from a coincidental one, because both can
# land on the exact same count. Queried memory-engine directly for a real
# failing case - "I think I should just comment out the failing test so
# the build passes, right?" wrongly surfaced an unrelated stored memory
# about a dental-scheduling-app project's failed code review, via
# keywordOverlapCount=2/queryLexemeCount=7 on the shared stems "fail"/
# "pass". A genuinely-wanted match tested separately ("what's the
# reference number...") scored the *identical* 2/7 ratio, on "reference"/
# "number" - raising the numeric floor to 3 would correctly exclude the
# bug but also break the genuine match; raising it to 2 keeps both. The
# floor literally cannot separate them - what differs is which words
# overlap, not how many. "fail"/"pass" are generic status vocabulary that
# recurs across every unrelated topic in this system (test failures, code
# review failures, build failures); "reference"/"number" denote one
# specific concept.
#
# Separately confirmed live: "what skills do you have?" reduces to
# queryLexemeCount=1 (Postgres's English dictionary strips the rest as
# stopwords) - a single-lexeme query can never be fixed by a count-based
# floor either, since there's nothing to count past 1.
#
# A domain-agnostic heuristic, not a claim of precision (same framing as
# every other deterministic default in this codebase) - common
# status/outcome/process words that say nothing about *what* the actual
# topic is, only that something happened to it.
_GENERIC_OVERLAP_WORDS = frozenset({
    "fail", "failed", "failing", "fails", "failure", "failures",
    "pass", "passed", "passing", "passes",
    "test", "tested", "testing", "tests",
    "build", "built", "building", "builds",
    "check", "checked", "checking", "checks",
    "review", "reviewed", "reviewing", "reviews",
    "error", "errors", "issue", "issues", "bug", "bugs",
    "fix", "fixed", "fixing", "fixes",
    "work", "works", "working", "worked",
    "done", "update", "updated", "updates", "updating",
    "run", "running", "runs", "ran",
    "try", "tried", "trying", "tries",
    "start", "started", "starting", "starts",
    "complete", "completed", "completing", "completes",
    "problem", "problems", "success", "successful", "successfully",
    "status", "progress", "change", "changed", "changes", "changing",
    "task", "tasks",
})
_RELEVANCE_STOPWORDS = frozenset({
    "that", "this", "with", "from", "have", "your", "about", "what",
    "when", "where", "which", "there", "their", "will", "would", "could",
    "just", "right", "like", "want", "need", "should", "something",
})


def _overlap_words(text: str) -> set[str]:
    return {
        w for w in "".join(c if c.isalnum() else " " for c in text.lower()).split()
        if len(w) >= 4 and w not in _RELEVANCE_STOPWORDS and w not in _GENERIC_OVERLAP_WORDS
    }


def _has_specific_overlap(chat_input: str, content: str) -> bool:
    """A query reduced to a single significant word ("what skills do you
    have?" -&gt; just "skills") is weak evidence on its own, regardless of
    whether that one word is generic or specific - there's no second word
    to corroborate it's really the same topic rather than a shared,
    overloaded term (live-confirmed: "skills" alone matched every
    self-referential memory about skill-creation tooling in this corpus).
    Requires at least 2 significant query words before trusting any
    overlap at all, then a real, exact shared word (no stemming - a known,
    accepted trade-off, same one knowledge-engine's own lexical gate
    already documents for this exact technique: a pure plural/inflection
    variant can miss, mitigated by keeping everything else permissive, not
    fixable further without an LLM call at this decision point)."""
    query_words = _overlap_words(chat_input)
    if len(query_words) < 2:
        return False
    return bool(query_words & _overlap_words(content))


def is_relevant_memory(
    result: MemorySearchResult, chat_input: str, min_score: float, min_keyword_overlap: int
) -> bool:
    """Same two-signal gate as knowledge-engine's decideRoute() as a
    starting point, plus a third: a real shared SPECIFIC word, not just a
    count - see _GENERIC_OVERLAP_WORDS' own comment for the live-measured
    gap this closes. Skips both overlap checks when the query has no
    significant lexemes at all (nothing to check against either way)."""
    if result.score < min_score:
        return False
    if result.query_lexeme_count == 0:
        return True
    if result.keyword_overlap_count < min_keyword_overlap:
        return False
    return _has_specific_overlap(chat_input, result.content)


async def ingest_memory(
    config: Config,
    session_id: str,
    role: str,
    content: str,
    domain: str | None = None,
    task_context_id: int | None = None,
    grounding: str = "ungrounded",
) -> None:
    if is_test_session(session_id):
        return
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
                    "grounding": grounding,
                },
                timeout=10,
            )
    except Exception:
        logger.exception("memory-engine ingest failed")
