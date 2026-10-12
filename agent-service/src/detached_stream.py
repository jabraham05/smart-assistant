"""Run a streaming chat turn to completion even if the client goes away.

A turn's work - including the post-turn writes (Honcho store_turn, session
memory, memory ingest, growth review log) - lives inside the async
generator that feeds the HTTP StreamingResponse. Starlette cancels that
generator when the client disconnects, so a phone that backgrounds the app
mid-reply (iOS suspends it and the socket drops) killed the turn partway
and the reply was never stored anywhere: gone from history and memory.

detach() moves the generator into its own task that always runs to the
end; the response just relays what it produces while someone is still
listening. A disconnect now only stops the relaying, never the turn.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

logger = logging.getLogger(__name__)

# Strong references to in-flight turns - the event loop only keeps weak
# references to tasks, and a detached turn has no other owner once its
# client is gone.
_in_flight: set[asyncio.Task[None]] = set()

_DONE = object()


async def detach(source: AsyncIterator[str], *, name: str) -> AsyncIterator[str]:
    queue: asyncio.Queue[object] = asyncio.Queue()

    async def pump() -> None:
        try:
            async for chunk in source:
                queue.put_nowait(chunk)
        except Exception:
            # The turn generator reports its own failures as an "error"
            # event; anything escaping it is a bug worth a log line, but
            # must not take the relay down with it.
            logger.exception("detached turn %s raised", name)
        finally:
            queue.put_nowait(_DONE)

    task = asyncio.create_task(pump(), name=name)
    _in_flight.add(task)
    task.add_done_callback(_in_flight.discard)

    while True:
        item = await queue.get()
        if item is _DONE:
            return
        yield item  # type: ignore[misc]


def in_flight_count() -> int:
    return len(_in_flight)
