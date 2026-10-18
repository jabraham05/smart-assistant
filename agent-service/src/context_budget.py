"""Unified, cross-category context budget.

Live testing found a real fabrication bug caused by aggregate context
volume, not any single bad source: a ~35K-character system prompt (persona +
skills + unrelated open tasks/goals + barely-relevant auto-injected
memory/knowledge) diluted the model's attention to a correct fact enough
that it substituted a wrong number, even though the right one was present
three separate ways. Capping each content category independently (e.g. "top
5 knowledge" regardless of how good this turn's tasks/goals are) doesn't fix
that - it can still stack multiple individually-allowed, mutually-irrelevant
things exactly the way the bug did. Memory retrieval, knowledge retrieval,
and task/goal matches all compete for the same finite budget; this module
pools every candidate across categories into one ranked list and fills a
single budget from the top, instead of independent per-category caps.

Pure, no I/O - the caller (context_builder.py) does the actual retrieval and
scoring; this only ranks and selects from what it's given.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TypeVar

T = TypeVar("T")

# Starting points to benchmark against real qwen3.5:9b latency/quality, not
# committed numbers - see the plan's rollout step on tuning these live.
BUDGET_CHARS: dict[str, int] = {"fast": 3000, "tool": 6000, "planning": 12000}


def _normalize_ranks(n: int, best_first_order: Sequence[int]) -> list[float]:
    """best_first_order[i] = original index of the i-th best item.
    Returns, per original index, a percentile rank in (0, 1] - 1.0 for the
    best item in this list, decaying toward 0 for the worst. Normalizing to
    a percentile (not a raw score) is what lets memory/knowledge (which
    carry a numeric RRF score) and tasks/goals (which carry no comparable
    score, only server-ranked order) merge into one fairly-ordered pool."""
    if n == 0:
        return []
    ranks = [0.0] * n
    for position, original_index in enumerate(best_first_order):
        ranks[original_index] = (n - position) / n
    return ranks


def rank_by_score(items: Sequence[T], score_fn: Callable[[T], float]) -> list[float]:
    """For memory/knowledge results, which carry a numeric RRF score."""
    order = sorted(range(len(items)), key=lambda i: score_fn(items[i]), reverse=True)
    return _normalize_ranks(len(items), order)


def rank_by_position(items: Sequence[T]) -> list[float]:
    """For tasks/goals, which carry no comparable numeric score - the
    caller's own retrieval (event_bus_client) already returns them
    best-match-first, so position order is itself the ranking signal."""
    return _normalize_ranks(len(items), list(range(len(items))))


def select_within_budget(
    # (category, original_index_within_that_category, rank, rendered_line_for_sizing)
    candidates: list[tuple[str, int, float, str]],
    budget_chars: int,
) -> dict[str, list[int]]:
    """Pools every candidate across categories into one ranked list,
    greedily includes highest-rank-first until the next line would exceed
    budget_chars, then returns the surviving original indices grouped back
    by category - each category's list restored to its own original
    (already-ranked) order, which is what each category's existing
    _format_*_line renderer expects to iterate over."""
    ordered = sorted(candidates, key=lambda c: c[2], reverse=True)
    selected: list[tuple[str, int]] = []
    total = 0
    for category, index, _rank, rendered in ordered:
        cost = len(rendered) + 1  # +1 for the newline joining lines together
        # Always take at least one candidate even if it alone exceeds
        # budget - an empty section is worse than one oversized line, and
        # this only ever happens for the single highest-ranked item.
        if selected and total + cost > budget_chars:
            continue
        total += cost
        selected.append((category, index))

    by_category: dict[str, list[int]] = {}
    for category, index in selected:
        by_category.setdefault(category, []).append(index)
    for indices in by_category.values():
        indices.sort()
    return by_category
