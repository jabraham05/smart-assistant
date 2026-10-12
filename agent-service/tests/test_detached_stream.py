import asyncio

from src.detached_stream import detach, in_flight_count


async def _turn(log: list[str]):
    """Stands in for a chat turn: streams, then does post-turn writes."""
    for word in ["a", "b", "c"]:
        await asyncio.sleep(0)
        yield word
    await asyncio.sleep(0.01)
    log.append("stored")  # the store_turn/memory writes after "end"


async def test_relays_everything_when_the_client_stays():
    log: list[str] = []
    out = [chunk async for chunk in detach(_turn(log), name="t1")]
    assert out == ["a", "b", "c"]
    assert log == ["stored"]


async def test_turn_finishes_and_stores_after_the_client_disconnects():
    log: list[str] = []
    relay = detach(_turn(log), name="t2")
    assert await relay.__anext__() == "a"
    # Client goes away mid-reply: Starlette closes the response iterator.
    await relay.aclose()
    assert log == []  # not finished yet...
    for _ in range(50):
        if log:
            break
        await asyncio.sleep(0.005)
    assert log == ["stored"]  # ...but it still completes and stores
    await asyncio.sleep(0)
    assert in_flight_count() == 0


async def test_turn_survives_cancellation_of_the_consumer_task():
    log: list[str] = []

    async def consume():
        async for _ in detach(_turn(log), name="t3"):
            await asyncio.sleep(1)  # slow client

    consumer = asyncio.create_task(consume())
    await asyncio.sleep(0.001)
    consumer.cancel()  # what a disconnect does to the response task
    for _ in range(50):
        if log:
            break
        await asyncio.sleep(0.005)
    assert log == ["stored"]


async def test_an_exception_in_the_turn_ends_the_relay_cleanly():
    async def broken():
        yield "a"
        raise RuntimeError("boom")

    out = [chunk async for chunk in detach(broken(), name="t4")]
    assert out == ["a"]
