# `agent-service` — PydanticAI runtime, now the live chat backend

Part of the [Smart Assistant](../README.md) project. Python/FastAPI
equivalent of [`docs/chat-orchestrator.md`](chat-orchestrator.md): same
wire contract, same per-turn pipeline shape, same `skills-mcp` tool host —
rebuilt on [PydanticAI](https://ai.pydantic.dev/) instead of a raw
Ollama/TypeScript tool-calling loop. Described in its own `pyproject.toml`
as "Phase 1 of the infrastructure rebuild, running alongside
chat-orchestrator (not replacing it) until proven via eval-harness parity +
a real soak period" — that framing is now partly out of date (see
"Current status" below).

See [`docs/growth-engine.md`](growth-engine.md) for the Growth
lifecycle subsystem (`growth_*.py`) that lives inside this service, and
[`docs/unified-architecture-gap-analysis.md`](unified-architecture-gap-analysis.md)
for the broader roadmap both this service and Growth implement pieces of.

## Current status: live, not just a parity candidate

`docker-compose.yml` has both `chat-ui` (`N8N_WEBHOOK_URL`) and
`discord-bot` (`N8N_CHAT_WEBHOOK_URL`) pointed at
`http://agent-service:3010/webhook` — **the cutover from
`chat-orchestrator` already happened**, not just planned. Per
`docker-compose.yml`'s own comment on the `chat-ui` service: formal
eval-harness parity (`scripts/eval-harness.mjs`, chat-orchestrator.md's
Phase 0 tool) **was never actually run** against `agent-service`; the
cutover instead shipped on real live smoke tests (plain replies, a real
`skills-mcp` tool call, repeated requests) after fixing a real streaming
bug found in the process (see "Bugs found" below). `scripts/eval-harness.mjs`
still defaults its target to `http://localhost:3008/webhook`
(`chat-orchestrator`'s port) — it was never pointed at `agent-service`,
formal parity testing is simply skipped for this cutover, not hidden
somewhere else.

**Rollback** (same instant-env-var-revert pattern `chat-orchestrator.md`
documents for its own relationship to n8n's `Chat` workflow): point
`N8N_WEBHOOK_URL`/`N8N_CHAT_WEBHOOK_URL` back to
`http://chat-orchestrator:3006/webhook`, or further back to n8n's own
`Chat` workflow
(`http://n8n:5678/webhook/370d9565-997b-4121-aca7-1128df3dc4ea/chat`).
`chat-orchestrator` is deliberately left running unmodified — same
"kept as rollback, not deleted" treatment `chat-orchestrator.md` describes
for the `Chat` workflow it replaced.

## Architecture

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
- **`skills_discovery.py`/`skills_library.py`** — reads real `SKILL.md`
  files (the [agentskills.io](https://agentskills.io/specification)
  format) from a dedicated Docker volume (`skills-library-data`), not from
  the repo — runtime-generated artifacts, same treatment as
  `postgres-data`.

## Config (`config.py`)

Deliberately mirrors `chat-orchestrator/src/config.ts`'s defaults (same
Ollama host, same `chat_model`/`qwen3:8b`, same Postgres/Redis/internal
service URLs) — the two services are meant to be interchangeable except
for which port each listens on (`3010` here vs. chat-orchestrator's
`3006`/test's `3009`). Reads the same `n8n` database (personas/skills,
`CHAT_DB_SCHEMA`-selectable between `public` and `chat_test`) and has its
own `growth` database (`GROWTH_DB_NAME`, see `docs/growth-engine.md`).
`GROWTH_JUDGE_MODEL` defaults to the larger `qwen3:14b` — an 8b judge is a
documented reliability risk for reflective-reasoning tasks in this
project.

## Bugs found standing this up (real, live-found — not caught by any test)

- **Streaming: `PartDeltaEvent` alone silently dropped every response's
  first chunk.** `PartDeltaEvent` only ever carries incremental updates to
  an already-started part; a new text part's first chunk — its entire
  initial content, not just one character — arrives on `PartStartEvent`
  instead. Handling only `PartDeltaEvent` reproduced 100% consistently
  across repeated identical requests ("PHASE1TEST" came back as "ASE1TEST"
  every time). Fixed in `main.py` by handling both event types.

## What's not yet true elsewhere in this repo's docs

- Top-level `README.md`'s directory layout section still describes
  `chat-orchestrator` as "what `chat-ui`/`discord-bot` actually talk to
  now" and doesn't mention `agent-service` at all — stale as of the real
  cutover documented above (tracked for the README pass).
- `pyproject.toml`'s own description ("running alongside chat-orchestrator
  ... until proven") undersells where things actually stand — it's already
  the live backend, just without the formal eval-harness parity step that
  description implies happened first.
