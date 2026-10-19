"""Decides what happens to a turn's reply text once it's known - the two
adaptive-response features layered on top of the plain NDJSON `item`/`ack`/
`trace`/`begin`/`end` wire contract main.py already streams.

Both decisions are deterministic and server-side, never a new field the
model has to output - same "don't trust the model to be disciplined when a
deterministic check can enforce it instead" house style as respond.py and
safety_net.py:

- `report_eligible`/`classify_reply`/`build_report_block`: a long,
  structured answer (knowledge/web/research/self-growth, past a length
  threshold) renders as a tappable report card instead of a wall of text.
  Decided once the final text is fully known.
- `BeatEmitter`: a reply with more than one natural "beat" (a blank-line
  break the model itself writes, per the persona's tone instructions)
  flushes a `block`/`beat_end` marker the moment that break completes in
  the stream, so the client can render it as several sequential bubbles
  instead of one. Decided live, beat by beat, as text arrives - not a
  post-hoc split of the finished reply.

Beats flush live on every turn now, including knowledge/web/research/
self-growth ones - a prior version gated beats off for those categories
to avoid ever needing to collapse live bubbles into a report card, but
that made every reply in those categories (a common case, especially
anything "consolidating information" for the user) render as one dense
paragraph with no separate texts at all, which was worse. The rare case
where a beat-split reply still ends up classified `"report"` once
`final_text` is fully known is handled client-side instead - iOS's
ChatViewModel collapses this turn's beat bubbles back to one, the same
mechanism it already uses for a mid-turn retry, the moment the `report`
block arrives.
"""

from __future__ import annotations

import re
from typing import Literal

# Categories that can plausibly produce a long, structured answer worth
# reading as a report rather than a chat bubble. Deliberately conservative -
# casual chat, scheduling, media, dashboard, goals, and info replies never
# become a report regardless of length.
_REPORT_ELIGIBLE_GROUPS = {"knowledge", "web", "research", "self-growth"}

# Long enough that short confirmations/lookups never get wrapped - a report
# card is for a genuinely long answer, not a couple of sentences.
_REPORT_LENGTH_THRESHOLD = 600

# A blank line (optionally with trailing spaces/tabs on either side) marks a
# beat boundary - the persona's tone instructions (system_prompt.py's
# tone_line) are what actually teach the model to write one when a reply
# has more than one distinct thought.
_BLANK_LINE = re.compile(r"\n[ \t]*\n")

# Never produce a 5th bubble - past this, everything flows into the 4th
# beat uninterrupted rather than fragmenting a reply into a wall of tiny
# texts.
_MAX_BEATS = 4

# Pacing chunk size for the fast/no-tool path (respond.py already returns
# the complete reply in one shot - there's nothing to watch live, so
# main.py re-chunks it itself purely to simulate the same live-typing feel
# the tool-using path gets for free). Small enough to look like natural
# typing, large enough not to spend forever re-emitting a long reply.
_PACING_WORDS_PER_CHUNK = 3


def report_eligible(relevant_groups: list[str]) -> bool:
    return bool(_REPORT_ELIGIBLE_GROUPS.intersection(relevant_groups))


def classify_reply(relevant_groups: list[str], text: str) -> Literal["text", "report"]:
    """Pure, deterministic - the only two inputs are already known once a
    turn's final text is settled (after every safety-net retry)."""
    if report_eligible(relevant_groups) and len(text) > _REPORT_LENGTH_THRESHOLD:
        return "report"
    return "text"


def build_report_block(text: str) -> dict:
    """Derives the wire payload for a `type:"block"` event with
    `blockType:"report"`. `title` is just the reply's own first line,
    capped short - no separate summary field/model call, per the user's
    own principle of not asking the small local model for extra structured
    output it doesn't already produce."""
    stripped = text.strip()
    first_line = stripped.split("\n", 1)[0].strip()
    title = first_line[:60].rstrip() if first_line else "Report"
    return {"blockType": "report", "title": title, "body": stripped}


def history_metadata(relevant_groups: list[str], text: str, beats_enabled: bool) -> dict | None:
    """The reply's layout, stored alongside it in chat history (Honcho
    message metadata) so a client reloading history renders it the same
    way it rendered live - otherwise a report card or multi-text reply
    flattens back to one plain bubble the moment the app re-reads history.

    `replyLayout: "beats"` carries no split points: the client re-splits
    the stored text on the same blank-line rule (and `_MAX_BEATS` cap)
    BeatEmitter applies live. None for a plain single-bubble reply."""
    if classify_reply(relevant_groups, text) == "report":
        return {"replyLayout": "report", "reportTitle": build_report_block(text)["title"]}
    if beats_enabled and _BLANK_LINE.search(text.strip()):
        return {"replyLayout": "beats"}
    return None


def chunk_for_pacing(text: str, words_per_chunk: int = _PACING_WORDS_PER_CHUNK) -> list[str]:
    """Splits an already-complete reply into small chunks for simulated
    streaming pacing. Captures each word together with its trailing
    whitespace (`\\S+\\s*`), so concatenating every chunk reproduces the
    original text exactly, blank lines included - BeatEmitter's boundary
    detection works identically whether its input came from this or from
    genuinely live per-token deltas."""
    if not text:
        return []
    tokens = re.findall(r"\S+\s*", text)
    return ["".join(tokens[i : i + words_per_chunk]) for i in range(0, len(tokens), words_per_chunk)]


class BeatEmitter:
    """Watches a turn's reply text as it arrives (live deltas, or
    pre-chunked already-complete text - see chunk_for_pacing) and flushes a
    `block`/`beat_end` marker the moment a blank-line boundary completes,
    so the client can start a new bubble right then instead of waiting for
    the whole reply to finish and splitting it after the fact.

    One instance per attempt (main.py constructs a fresh one for every
    `_run_turn` call, including retries) - a retry already resets the
    client's displayed state via its own `trace{kind:"retry"}` event, so
    there's nothing to carry over from a failed attempt's beat count.
    """

    def __init__(self, emit) -> None:
        self._emit = emit
        self._buffer = ""
        self._beat_count = 1

    def feed(self, delta: str) -> list[str]:
        """Returns the NDJSON lines to yield, in order, for one incoming
        chunk of text: the `item` event carrying the text itself, followed
        by zero or more `beat_end` markers if the chunk completed one or
        more blank-line boundaries (rare, but a single large chunk - e.g.
        PartStartEvent's initial content, or a wide pacing chunk - can
        contain more than one)."""
        events = [self._emit("item", delta)]
        if not delta:
            return events
        self._buffer += delta
        while self._beat_count < _MAX_BEATS:
            match = _BLANK_LINE.search(self._buffer)
            if not match:
                break
            self._buffer = self._buffer[match.end() :]
            self._beat_count += 1
            events.append(self._emit("block", '{"blockType": "beat_end"}'))
        return events
