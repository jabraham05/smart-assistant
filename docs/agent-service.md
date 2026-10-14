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

