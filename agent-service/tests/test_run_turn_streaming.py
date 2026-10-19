"""_run_turn must hand each piece of the reply to the client the moment the
model produces it - not collect the whole attempt and release it at the end
(which is what it used to do, so replies arrived in one burst)."""

import asyncio
import json
import os

os.environ.setdefault("POSTGRES_PASSWORD", "test")  # load_config() at import

from pydantic_ai.messages import PartDeltaEvent, PartStartEvent, TextPart, TextPartDelta  # noqa: E402

from src import main  # noqa: E402


class _FakeStream:
    """Yields the first text part, then waits for `release` before the rest -
    so a chunk observed before release proves it was streamed live."""

    def __init__(self, release: asyncio.Event):
        self.release = release

    async def __aenter__(self):
        return self._events()

    async def __aexit__(self, *exc):
        return False

    async def _events(self):
        yield PartStartEvent(index=0, part=TextPart(content="Hello"))
        await self.release.wait()
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta=" there."))


class _FakeAgent:
    def __init__(self, release: asyncio.Event):
        self.release = release

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def run_stream_events(self, *args, **kwargs):
        return _FakeStream(self.release)


def _content(chunk: str) -> str | None:
    return json.loads(chunk).get("content")


async def test_text_reaches_the_client_before_the_attempt_finishes(monkeypatch):
    release = asyncio.Event()
    monkeypatch.setattr(main, "build_agent", lambda *a, **k: _FakeAgent(release))

    out = main._Attempt()
    emit = main._emit([0])
    turn = main._run_turn(
        main.config, "s1", "system", "hi", [], main._TurnState(), emit, [], out, False
    ).__aiter__()

    first = await asyncio.wait_for(turn.__anext__(), timeout=1)
    assert _content(first) == "Hello"
    assert not release.is_set()  # the model is still mid-reply...
    assert out.text == ""  # ...and the attempt hasn't finished

    release.set()
    rest = [c async for c in turn]
    assert [_content(c) for c in rest] == [" there."]
    assert out.text == "Hello there."


async def test_a_failed_attempt_reports_empty_text(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(main, "build_agent", boom)
    out = main._Attempt(text="stale")
    chunks = [c async for c in main._run_turn(
        main.config, "s1", "system", "hi", [], main._TurnState(), main._emit([0]), [], out, False
    )]
    assert chunks == []
    assert out.text == ""


class _FakeBeatStream:
    """Yields text containing a mid-reply blank line, in two chunks - a
    PartStartEvent followed by a PartDeltaEvent, same shape as a real
    model reply with more than one conversational beat. Unlike _FakeStream
    above, __aenter__ returns `self` (not a bare async generator) so
    `stream.usage` (main.py's post-loop logging line) has somewhere to
    resolve to, same as the real pydantic-ai stream object would provide."""

    usage = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self._events()

    async def _events(self):
        yield PartStartEvent(index=0, part=TextPart(content="Let me check.\n"))
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="\nIt's 62°F and clear."))


class _FakeBeatAgent:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def run_stream_events(self, *args, **kwargs):
        return _FakeBeatStream()


def _event_type(chunk: str) -> str:
    return json.loads(chunk)["type"]


async def test_beats_enabled_flushes_a_beat_end_marker_on_a_blank_line_boundary(monkeypatch):
    monkeypatch.setattr(main, "build_agent", lambda *a, **k: _FakeBeatAgent())

    out = main._Attempt()
    chunks = [c async for c in main._run_turn(
        main.config, "s1", "system", "hi", [], main._TurnState(), main._emit([0]), [], out, True
    )]
    assert [_event_type(c) for c in chunks] == ["item", "item", "block"]
    assert out.text == "Let me check.\n\nIt's 62°F and clear."


async def test_beats_disabled_never_emits_a_beat_end_marker_even_with_a_blank_line(monkeypatch):
    # Report-eligible turns stream as a single growing bubble regardless
    # of whether the text happens to contain a blank line.
    monkeypatch.setattr(main, "build_agent", lambda *a, **k: _FakeBeatAgent())

    out = main._Attempt()
    chunks = [c async for c in main._run_turn(
        main.config, "s1", "system", "hi", [], main._TurnState(), main._emit([0]), [], out, False
    )]
    assert [_event_type(c) for c in chunks] == ["item", "item"]
