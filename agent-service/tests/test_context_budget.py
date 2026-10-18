"""Unit tests for src/context_budget.py's pure ranking/selection functions."""

from src.context_budget import rank_by_position, rank_by_score, select_within_budget


def test_rank_by_score_best_item_gets_highest_rank():
    items = [{"score": 0.01}, {"score": 0.05}, {"score": 0.03}]
    ranks = rank_by_score(items, lambda x: x["score"])
    # item 1 (score 0.05) is best -> highest rank; item 0 (0.01) is worst -> lowest rank
    assert ranks[1] > ranks[2] > ranks[0]


def test_rank_by_score_empty_list():
    assert rank_by_score([], lambda x: x) == []


def test_rank_by_position_first_item_gets_highest_rank():
    ranks = rank_by_position(["a", "b", "c"])
    assert ranks[0] > ranks[1] > ranks[2]


def test_select_within_budget_pools_across_categories_by_rank():
    # Two categories, interleaved by rank - the pool should pick the
    # globally-highest-ranked items regardless of which category they
    # came from, not an equal/independent slice per category.
    candidates = [
        ("memory", 0, 0.9, "x" * 100),
        ("memory", 1, 0.2, "x" * 100),
        ("knowledge", 0, 0.8, "x" * 100),
        ("knowledge", 1, 0.1, "x" * 100),
    ]
    result = select_within_budget(candidates, budget_chars=250)
    # Only the two highest-ranked (0.9 memory, 0.8 knowledge) fit in 250 chars
    # (each line costs 101 chars); the two low-ranked ones (0.2, 0.1) don't.
    assert result == {"memory": [0], "knowledge": [0]}


def test_select_within_budget_always_keeps_at_least_the_top_item_even_if_oversized():
    candidates = [("memory", 0, 1.0, "x" * 10_000)]
    result = select_within_budget(candidates, budget_chars=100)
    assert result == {"memory": [0]}


def test_select_within_budget_restores_original_order_within_category():
    # rank order is reversed vs original index order - selection must still
    # come back sorted by original index, matching what each category's
    # own renderer expects to iterate over.
    candidates = [
        ("memory", 0, 0.1, "x" * 10),
        ("memory", 1, 0.9, "x" * 10),
        ("memory", 2, 0.5, "x" * 10),
    ]
    result = select_within_budget(candidates, budget_chars=1000)
    assert result == {"memory": [0, 1, 2]}


def test_select_within_budget_empty_candidates():
    assert select_within_budget([], budget_chars=1000) == {}
