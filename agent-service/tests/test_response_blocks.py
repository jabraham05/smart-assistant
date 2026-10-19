"""Unit tests for src/response_blocks.py - classify_reply/build_report_block
(Feature A: report cards) and BeatEmitter/chunk_for_pacing (Feature B:
live conversational multi-text). Pure functions/stateful-but-no-I/O, no
Ollama/network dependency, same spirit as test_respond.py."""

import json

from src.response_blocks import (
    BeatEmitter,
    build_report_block,
    chunk_for_pacing,
    classify_reply,
    report_eligible,
)

_LONG_TEXT = "x" * 601
_SHORT_TEXT = "x" * 599


def _collect(emitted: list[str]) -> list[dict]:
    return [json.loads(line.rstrip("\n")) for line in emitted]


# --- report_eligible / classify_reply -------------------------------------


def test_report_eligible_true_for_each_eligible_group():
    for group in ("knowledge", "web", "research", "self-growth"):
        assert report_eligible([group]) is True


def test_report_eligible_false_for_non_eligible_groups():
    assert report_eligible(["media", "scheduling", "dashboard", "goals", "info"]) is False
    assert report_eligible([]) is False


def test_classify_reply_never_reports_short_text_regardless_of_group():
    for group in ("knowledge", "web", "research", "self-growth"):
        assert classify_reply([group], _SHORT_TEXT) == "text"


def test_classify_reply_never_reports_long_text_in_non_eligible_group():
    assert classify_reply(["media"], _LONG_TEXT) == "text"
    assert classify_reply([], _LONG_TEXT) == "text"


def test_classify_reply_reports_long_text_in_eligible_group():
    assert classify_reply(["knowledge"], _LONG_TEXT) == "report"
    assert classify_reply(["web"], _LONG_TEXT) == "report"
    assert classify_reply(["research"], _LONG_TEXT) == "report"
    assert classify_reply(["self-growth"], _LONG_TEXT) == "report"


def test_classify_reply_boundary_at_threshold():
    # Exactly at the threshold is NOT past it - strictly greater-than.
    exactly_600 = "x" * 600
    assert classify_reply(["knowledge"], exactly_600) == "text"
    assert classify_reply(["knowledge"], exactly_600 + "x") == "report"


def test_classify_reply_mixed_groups_reports_if_any_group_eligible():
    assert classify_reply(["media", "web"], _LONG_TEXT) == "report"


# --- build_report_block ----------------------------------------------------


def test_build_report_block_uses_first_line_as_title():
    block = build_report_block("Best headphones under $200\n\nSony leads on battery life.")
    assert block["blockType"] == "report"
    assert block["title"] == "Best headphones under $200"
    assert block["body"] == "Best headphones under $200\n\nSony leads on battery life."


def test_build_report_block_caps_title_length():
    first_line = "x" * 100
    block = build_report_block(f"{first_line}\n\nmore body text")
    assert len(block["title"]) == 60


def test_build_report_block_strips_surrounding_whitespace():
    block = build_report_block("  \n  Title line  \n\nBody\n\n  ")
    assert block["title"] == "Title line"
    assert block["body"] == "Title line  \n\nBody"


def test_build_report_block_falls_back_to_report_title_for_blank_text():
    # strip() runs before the first-line split, so only a genuinely
    # empty/whitespace-only body hits the fallback - leading blank lines
    # before real content don't (the real first line is whatever's left
    # after stripping).
    block = build_report_block("   \n\n   ")
    assert block["title"] == "Report"
    assert block["body"] == ""


# --- chunk_for_pacing --------------------------------------------------------


def test_chunk_for_pacing_reassembles_exactly():
    text = "Let me check.\n\nIt's 62°F and clear right now, feels like 60."
    chunks = chunk_for_pacing(text)
    assert "".join(chunks) == text


def test_chunk_for_pacing_empty_text_returns_no_chunks():
    assert chunk_for_pacing("") == []


def test_chunk_for_pacing_respects_words_per_chunk():
    text = "one two three four five six"
    chunks = chunk_for_pacing(text, words_per_chunk=2)
    assert len(chunks) == 3
    assert "".join(chunks) == text


# --- BeatEmitter -------------------------------------------------------------


def test_beat_emitter_single_chunk_no_blank_line_emits_only_item():
    emit = lambda event_type, content=None, trace=None: json.dumps(  # noqa: E731
        {"type": event_type, "content": content}
    ) + "\n"
    emitter = BeatEmitter(emit)
    events = _collect(emitter.feed("just one normal sentence"))
    assert events == [{"type": "item", "content": "just one normal sentence"}]


def test_beat_emitter_flushes_beat_end_on_blank_line_boundary():
    emit = lambda event_type, content=None, trace=None: json.dumps(  # noqa: E731
        {"type": event_type, "content": content}
    ) + "\n"
    emitter = BeatEmitter(emit)
    events = _collect(emitter.feed("Let me check.\n\nIt's 62°F and clear."))
    assert [e["type"] for e in events] == ["item", "block"]
    assert json.loads(events[1]["content"]) == {"blockType": "beat_end"}


def test_beat_emitter_boundary_split_across_multiple_feed_calls():
    emit = lambda event_type, content=None, trace=None: json.dumps(  # noqa: E731
        {"type": event_type, "content": content}
    ) + "\n"
    emitter = BeatEmitter(emit)
    first = _collect(emitter.feed("Let me check.\n"))
    assert [e["type"] for e in first] == ["item"]
    second = _collect(emitter.feed("\nIt's 62°F and clear."))
    assert [e["type"] for e in second] == ["item", "block"]


def test_beat_emitter_caps_at_four_beats_merging_overflow():
    emit = lambda event_type, content=None, trace=None: json.dumps(  # noqa: E731
        {"type": event_type, "content": content}
    ) + "\n"
    emitter = BeatEmitter(emit)
    # 5 beats worth of blank-line-separated text - only 3 boundaries should
    # ever flush (1 -> 2 -> 3 -> 4), the 4th/5th boundary never fires since
    # the cap is already reached, so beat 4 absorbs everything after it.
    text = "one\n\ntwo\n\nthree\n\nfour\n\nfive"
    events = _collect(emitter.feed(text))
    beat_ends = [e for e in events if e["type"] == "block"]
    assert len(beat_ends) == 3
    item_events = [e for e in events if e["type"] == "item"]
    # The single incoming delta is still forwarded whole via one "item"
    # event regardless of how many boundaries it completes.
    assert item_events == [{"type": "item", "content": text}]


def test_beat_emitter_empty_delta_is_a_no_op_beyond_the_item_event():
    emit = lambda event_type, content=None, trace=None: json.dumps(  # noqa: E731
        {"type": event_type, "content": content}
    ) + "\n"
    emitter = BeatEmitter(emit)
    events = _collect(emitter.feed(""))
    assert events == [{"type": "item", "content": ""}]
