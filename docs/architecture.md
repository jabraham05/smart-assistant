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
  `docker-compose.yml` service, internal-only (no published port — n8n
  reaches it at `http://skills-mcp:3001/mcp` over `assistant-net`). Hosts
  agent-callable tools — see `skills-mcp/src/tools/` for the current list
  (`memory_recall`, `weather_get`, `skill_propose`, `calendar_event`,
  `code_task`, `spotify_control`, `dashboard_control`, `web_search`,
  `research_task`, `research_task_status`, `research_search` as of
  this writing)
  — added by registering each in `server.ts` following the
  same `registerTool`/zod/`textResult` pattern. Names use a consistent
  `domain_verb` prefix convention (not the original `verb_noun` names some
  of these launched with — see the tool-count/naming decision in
  [`docs/persona-system.md`](persona-system.md)) so
  selection stays unambiguous as the tool count grows. See
  [`docs/chat-workflow.md`](chat-workflow.md) for the tool-calling
  reliability work this unblocked, and
  [`docs/skill-proposals.md`](skill-proposals.md) for `skill_propose`.
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
  (see [`docs/research-workflow.md`](research-workflow.md)) that's the first
  real consumer of pgvector: `research_chunks.embedding` is a genuine
  `vector(768)` column, populated by the `nomic-embed-text` Ollama model.
- **redis** — provisioned, not yet wired into anything specific.
