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
        main.config, "s1", "system", "hi", [], main._TurnState(), emit, [], out
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
        main.config, "s1", "system", "hi", [], main._TurnState(), main._emit([0]), [], out
    )]
    assert chunks == []
    assert out.text == ""
