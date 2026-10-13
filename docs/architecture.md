# Architecture

Part of the [Smart Assistant](../README.md) project — see the README for the
project overview, setup instructions, and directory layout.

n8n orchestrates a local Ollama model as the "brain," Honcho (hosted cloud)
provides long-term memory of who you are, and postgres/redis back everything.

For the `Chat` workflow's own node-by-node pipeline (the actual chat request
flow, garbage-output safety net, etc.), see
[`docs/chat-workflow.md`](chat-workflow.md).

- **n8n** — orchestrator. Skills are n8n workflows; agent-callable tools now
  live behind `skills-mcp` (below), consumed via n8n's native `MCP Client
  Tool` node rather than as bespoke HTTP Request Tool nodes per skill.
- **skills-mcp** — a small standalone MCP server (Node/TypeScript,
  `@modelcontextprotocol/sdk`, Streamable HTTP transport), its own
  `docker-compose.yml` service, internal-only (no published port —
  reached at `http://skills-mcp:3001/mcp` over `assistant-net`, now by
  three consumers: n8n's other workflows, `coding-orchestrator`'s agent
  loop, and `chat-orchestrator`, below). Hosts agent-callable tools — see
  `skills-mcp/src/tools/` and `server.ts` for the authoritative
  current list (as of this writing: `memory_recall`, `weather_get`,
  `skill_propose`, `calendar_event`, `code_task` + its session-scoped
  siblings `code_task_status`/`run_command`/`get_diff`/`write_file`,
  `spotify_control`, `dashboard_control`, `web_search`,
  `knowledge_search`, `knowledge_ingest`, `research_task`,
  `research_task_status`, `goal_manage`, `task_context_manage`,
  `calculate`, `drive_search`, plus the Growth engine's
  `growth_review`/`project_propose`/`project_complete`/`status_overview`/
  `teaching_session_manage`/`skill_examples` (see
  [`docs/growth-engine.md`](growth-engine.md)) — 26 registered tools
  total (one `registerTool`/`register*` call per tool in `server.ts`),
  though the `run_command`/`get_diff`/`write_file`/
  `code_task_status` cluster is pipeline-internal, scoped to an active
  coding-agent's own tool-calling loop, not exposed to general chat)
  — added by registering each in `server.ts` following the
  same `registerTool`/zod/`textResult` pattern. Names use a consistent
  `domain_verb` prefix convention (not the original `verb_noun` names some
  of these launched with — see the tool-count/naming decision in
  [`docs/persona-system.md`](persona-system.md)) so
  selection stays unambiguous as the tool count grows. See
  [`docs/chat-workflow.md`](chat-workflow.md) for the tool-calling
  reliability work this unblocked, and
  [`docs/skill-proposals.md`](skill-proposals.md) for `skill_propose`.
- **chat-orchestrator** — self-hosted replacement for the `Chat`
  workflow's `AI Agent`/`MCP Client Tool` tool-calling, running a raw
  Ollama tool-calling loop against a real MCP client connected to
  `skills-mcp` (see [`docs/chat-orchestrator.md`](chat-orchestrator.md)).
  `chat-ui` and `discord-bot` both talk to this now, not n8n, for real
  chat traffic — n8n's `Chat` workflow stays published as the rollback.
- **Ollama** — local LLM inference (GPU). `OLLAMA_KEEP_ALIVE=-1` plus an
  `ollama-warmup` one-shot service keep the default model resident in VRAM
  at all times, so there's no cold-start tax after the stack comes up.
- **Honcho** (hosted, [app.honcho.dev](https://app.honcho.dev)) — long-term
  memory / user modeling, with a web dashboard to see what it has learned.
  This is the one deliberate exception to "everything else is local and
  free" — it needs a real API key. Self-hosting was tried and abandoned;
  see `honcho-src/` note in [directory layout](../README.md#directory-layout).
- **postgres** (`pgvector/pgvector:pg16`) — backs n8n itself (`n8n` database)
  and the Postgres Chat Memory node, plus a separate `research` database
  (see [`docs/knowledge-engine.md`](knowledge-engine.md)) that's the first
  real consumer of pgvector: `chunks.embedding` is a genuine
  `vector(768)` column, populated by the `nomic-embed-text` Ollama model.
  Several other services have since gained their own dedicated database on
  this same instance (`CREATE DATABASE`-separated, not schemas within
  one) — `coding_tasks`, `events`, `memory`, `skills`, `growth` per
  `postgres/init/` — each documented under its own service's doc rather
  than enumerated here.
- **redis** — now backs `chat-orchestrator`'s short-term session memory
  (`chat-orchestrator/src/session-memory.ts`, `MAX_TURNS` 15, 30-day TTL),
  replacing n8n's Postgres Chat Memory node for live chat traffic; its
  `prod`/`test` instances use separate `REDIS_DB` indices (0/1 per
  `docker-compose.yml`) so their session buffers never collide.
  `agent-service` (`docker-compose.yml`) also has its own `REDIS_DB` (2) —
  a separate service not otherwise covered in this file.
