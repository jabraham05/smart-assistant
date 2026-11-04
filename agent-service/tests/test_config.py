"""Unit tests for src/config.py's pure helpers."""

from src.config import is_test_user


def test_is_test_user_matches_literal_test_id():
    assert is_test_user("test") is True


def test_is_test_user_does_not_match_real_user_ids():
    assert is_test_user("john") is False
    assert is_test_user("amy-main") is False
    assert is_test_user("discord-746463391039881246") is False


def test_is_test_user_handles_none_and_empty():
    # Safe-by-default: no explicit identity means treated as test, never
    # silently treated as real.
    assert is_test_user(None) is True
    assert is_test_user("") is True
