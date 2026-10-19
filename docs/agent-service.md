# `agent-service` — PydanticAI runtime, now the live chat backend

Part of the [Smart Assistant](../README.md) project. Python/FastAPI
equivalent of the now-retired `chat-orchestrator` (see
[`docs/chat-orchestrator.md`](chat-orchestrator.md), kept for history):
same wire contract, same per-turn pipeline shape, same `skills-mcp` tool
host — rebuilt on [PydanticAI](https://ai.pydantic.dev/) instead of a raw
Ollama/TypeScript tool-calling loop.

See [`docs/growth-engine.md`](growth-engine.md) for the Growth
lifecycle subsystem (`growth_*.py`) that lives inside this service, and
[`docs/unified-architecture-gap-analysis.md`](unified-architecture-gap-analysis.md)
for the broader roadmap both this service and Growth implement pieces of.

## Current status: live

`docker-compose.yml` has both `chat-ui` (`N8N_WEBHOOK_URL`) and
`discord-bot` (`N8N_CHAT_WEBHOOK_URL`) pointed at
`http://agent-service:3010/webhook`. Formal eval-harness parity
(`scripts/eval-harness.mjs`, `chat-orchestrator.md`'s Phase 0 tool) **was
never actually run** against `agent-service`; the cutover instead shipped
on real live smoke tests (plain replies, a real `skills-mcp` tool call,
repeated requests) after fixing a real streaming bug found in the process
(see "Bugs found" below).

**Retired, 2026-10-13: `chat-orchestrator`, the nearer rollback this once
had, has been deleted** (see `docs/chat-orchestrator.md`) - it was never
actually needed as a rollback during its soak period. **Rollback** now
means n8n's own `Chat` workflow, one layer further back: point
`N8N_WEBHOOK_URL`/`N8N_CHAT_WEBHOOK_URL` to
`http://n8n:5678/webhook/370d9565-997b-4121-aca7-1128df3dc4ea/chat`. Before
deleting `chat-orchestrator`, its two read-only profile routes
(`GET /persona`, `GET /user-profile` - powering chat-ui's Amy Lab
"Profiles" tab, which read from them directly rather than `agent-service`)
were ported here as `src/profile_routes.py`, so nothing in chat-ui broke.

## Architecture

### Current lookup and research routing

Amy's immediate factual-search tool is `knowledge_lookup`. It calls the
knowledge-engine's saved-document search and live web passage search in
parallel and returns separate labeled results. `memory_recall` remains for
personal facts from prior conversations. Legacy `web_search` and
`knowledge_search` remain registered in skills-mcp for compatibility, but
the live classifier maps both old categories to `knowledge_lookup`.

The `research` category exposes `growth_research_request`, not the direct
`research_task` executor. Growth decides whether work should proceed;
Planner's research profile scopes the approved request; knowledge-engine's
Research agent executes it and persists the document. See
[`planner-agent.md`](planner-agent.md) for the shared Planner contract.

`agent-service/src/main.py` is the Python equivalent of
`chat-orchestrator/src/index.ts`'s turn orchestration: classify → assemble
system prompt → run the PydanticAI agent (streamed) → apply safety-net
retries → persist to Honcho/Redis/memory-engine. Same NDJSON wire contract
both real clients already parse (`{type, content, metadata: {nodeId,
nodeName: "AI Agent", ...}}`) — a hard constraint, not a nice-to-have,
since neither client changed for this migration.

- **`agent.py`** — builds the PydanticAI `Agent` (`AgentDeps`), bound to
  tools from the same real MCP client against `skills-mcp` that
  `chat-orchestrator` uses.
- **`classify.py`** — the Coordinator classification call (tool groups,
  `toolPolicy`/`memoryPolicy`/`needsPlanning`/`background`,
  `knowledgeGapTopic`, `behaviorFeedback`, `isCorrection`) — same schema
  `chat-orchestrator/src/classify-tools.ts` produces, see
  `docs/chat-orchestrator.md`'s Coordinator section for what each field
  drives.
- **`system_prompt.py`** — persona + date + Honcho cards + skills catalog +
  goals/task-context injection, same shape as
  `chat-orchestrator/src/system-prompt.ts`.
- **`safety_net.py`** — Python port of `chat-orchestrator/src/safety-net.ts`.
  Not a fixed 1:1 mirror: the two have already diverged in both
  directions, e.g. `has_tool_failure_narration`'s `TOOL_FAILURE_RELEVANT_TOOLS`
  exists only here (see `docs/chat-orchestrator.md`'s 2026-10-12 entry),
  while other checks exist in both. Check both files directly rather than
  assuming parity before relying on either's exact behavior.
- **`context_builder.py`** — named Context Builder (Growth engine roadmap
  Phase 6, see `docs/growth-engine.md`).
- **`growth_db.py`/`growth_consolidate.py`/`growth_judge.py`/
  `growth_routes.py`/`growth_graphiti.py`/`growth_background.py`** — the
  Growth lifecycle; fully documented in `docs/growth-engine.md`, not
  repeated here. `growth_background.start_background_loop` is kicked off
  on FastAPI startup (Phase 9's autonomous loop), fire-and-forget, with its
  own internal crash isolation so a bug in it can never take down the
  webhook.
- **`honcho_client.py`/`knowledge_client.py`/`memory_client.py`/
  `event_bus_client.py`** — thin HTTP clients to the same four services
  `chat-orchestrator` talks to directly.
- **`session_memory.py`** — Redis-backed short-term turn buffer, same
  `REDIS_DB` convention as `chat-orchestrator/src/session-memory.ts`.
- **`profile_routes.py`** — `GET /persona`/`GET /user-profile`, ported
  from `chat-orchestrator` (now retired) when it was deleted. Powers
  chat-ui's Amy Lab "Profiles" tab via `chat-ui/src/lib/profile-client.ts`.
- **`skills_discovery.py`/`skills_library.py`** — reads real `SKILL.md`
  files (the [agentskills.io](https://agentskills.io/specification)
  format) from a dedicated Docker volume (`skills-library-data`), not from
  the repo — runtime-generated artifacts, same treatment as
  `postgres-data`.

## Adaptive responses (`response_blocks.py`) — report cards + conversational multi-text

Two deterministic, server-side decisions layered on top of the plain
`begin`/`item`/`ack`/`trace`/`end`/`error` wire contract above, both
feeding a new additive event: `{"type": "block", "content": "<json
string>", "metadata": {...}}` — the existing contract's `type:"item"` +
`metadata.nodeName:"AI Agent"` rule for reply text is untouched, so an
older client simply ignores `block` events it doesn't recognize (`APIModels.
swift`'s `StreamEvent.Kind` already tolerates unknown types via `.other`).

- **Report cards** — a long, structured answer (one of the `knowledge`/
  `web`/`research`/`self-growth` classifier categories, past 600 chars)
  renders as a tappable report card instead of a wall of text.
  `response_blocks.classify_reply(relevant_groups, final_text)` decides
  this once `final_text` has settled through every safety-net retry (right
  before `yield emit("end")`); if it returns `"report"`, one extra
  `block` event is emitted with `{"blockType": "report", "title", "body"}`
  (`response_blocks.build_report_block`). Additive, not a replacement —
  whatever was already streamed as `item` text stays on the wire too; the
  client decides whether to keep it or swap to the card.
- **Conversational multi-text** — a reply with more than one natural
  "beat" (a blank line the model itself writes, taught in
  `system_prompt.py`'s `tone_line`) flushes a `{"blockType": "beat_end"}`
  marker (no payload beyond that — the beat's own text already arrived as
  ordinary `item` deltas before the marker) the moment that blank-line
  boundary completes in the stream, live, not after the full reply is
  drafted and split after the fact. `response_blocks.BeatEmitter` owns
  this: capped at 4 beats, fed from two different sources depending on
  which path produced the text —
  - the tool-using agent loop (`_run_turn`'s own `PartStartEvent`/
    `PartDeltaEvent` handling) already streams real deltas live; they're
    routed through `BeatEmitter` directly, no artificial delay.
  - the fast/no-tool path (`respond.py`) gets the complete `response`
    string from Ollama in one non-streamed shot — nothing to watch live.
    `main.py` re-chunks that already-complete text itself
    (`response_blocks.chunk_for_pacing`) and feeds the chunks through the
    same `BeatEmitter` with a small `asyncio.sleep` between them, purely
    to simulate the same live-typing feel. A deliberate, bounded exception
    to not adding server-side delays elsewhere in this file.

Report-eligibility and beat-flushing are mutually exclusive per turn,
decided upfront from `relevant_groups` **before** generation starts
(`main.py`'s `beats_enabled = not response_blocks.report_eligible(...)`)
— a report-eligible turn always streams as a single growing bubble
(today's behavior, unchanged) and only maybe becomes a report card at the
very end; every other turn is beat-flush-eligible instead and never
becomes a report. They can't both be decided at the end: by the time a
long reply has finished streaming as several already-revealed beat
bubbles, collapsing them into one report card would be a visible flash.

A fresh `BeatEmitter` is constructed per `_run_turn` attempt (every retry
gets its own) rather than threaded across retries — a retry already
resets the client's displayed state via its own `trace{kind:"retry"}`
event, so there's nothing from a failed attempt worth carrying forward.

The layout is also stored with the reply in history:
`response_blocks.history_metadata` goes into the Honcho message's
`metadata` (`{"replyLayout": "report", "reportTitle"}` or
`{"replyLayout": "beats"}`; nothing for a plain reply), and chat-ui's
`/api/sessions/[id]/messages` passes it through untouched. The iOS app
rebuilds the card or beat bubbles from it on reload
(`ChatViewModel.messages(from:)`, re-splitting beats on the same
blank-line rule and 4-beat cap) - without it, every history reload
(app back from the background, pull to refresh) flattened the reply back
to one plain bubble. Replies stored before this have no metadata and stay
plain.

## Config (`config.py`)

Reads the same `n8n` database (personas/skills, `CHAT_DB_SCHEMA`-selectable
between `public` and `chat_test`) and has its own `growth` database
(`GROWTH_DB_NAME`, see `docs/growth-engine.md`). `CHAT_MODEL`/
`CHAT_CLASSIFIER_MODEL`/`GROWTH_JUDGE_MODEL` all default to `qwen3.5:9b` —
consolidated onto one model everywhere, 2026-10, after live benchmarking
(`scripts/benchmark-results/`, including a real execution-verified
agentic coding task) showed it matching or beating the bigger `qwen3:14b`
previously used for the Growth judge specifically (an 8b-class model was
a documented reliability risk for its reflective-reasoning task; `qwen3.5:9b`
is a newer generation and didn't show that risk on the equivalent test).
Sharing one model everywhere also eliminates the real VRAM-swap cost
between differently-sized models that didn't both fit in 12GB at once -
see `growth_judge.py`'s `_unload_model`, now a no-op when
`growth_judge_model` equals `chat_model`.

## Bugs found standing this up (real, live-found — not caught by any test)

- **Streaming: `PartDeltaEvent` alone silently dropped every response's
  first chunk.** `PartDeltaEvent` only ever carries incremental updates to
  an already-started part; a new text part's first chunk — its entire
  initial content, not just one character — arrives on `PartStartEvent`
  instead. Handling only `PartDeltaEvent` reproduced 100% consistently
  across repeated identical requests ("PHASE1TEST" came back as "ASE1TEST"
  every time). Fixed in `main.py` by handling both event types.

