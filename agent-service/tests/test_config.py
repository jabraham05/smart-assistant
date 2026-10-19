"""Unit tests for src/config.py's pure helpers."""

from src.config import is_test_session


def test_is_test_session_matches_prefix():
    assert is_test_session("test-anything") is True
    assert is_test_session("test-") is True


def test_is_test_session_does_not_match_real_sessions():
    assert is_test_session("amy-main") is False
    assert is_test_session("discord-746463391039881246") is False


def test_is_test_session_does_not_match_old_ad_hoc_test_patterns():
    # Confirms the new convention is deliberately narrower than the
    # historical ad-hoc names (cap-, verify-, eval-, etc.) found and purged
    # from production stores this session - those are no longer how a test
    # session should be named going forward.
    assert is_test_session("verify-something") is False
    assert is_test_session("cap2-memory") is False


def test_is_test_session_handles_none_and_empty():
    assert is_test_session(None) is False
    assert is_test_session("") is False
