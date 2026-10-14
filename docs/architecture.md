# Current architecture

Amy's live chat backend is `agent-service` (Python/FastAPI/PydanticAI), not
the retired `chat-orchestrator`. `chat-ui` and `discord-bot` reach it through
the configured webhook. `agent-service` builds context, classifies the turn,
binds only relevant MCP tools from `skills-mcp`, streams the reply, applies
deterministic safety checks, and persists the conversation.

## Knowledge and research flow

For an immediate factual question, Amy calls one `knowledge_lookup` tool.
That tool queries the saved world-knowledge store and live web concurrently,
and returns each source separately with citations. Personal facts and past
conversation recall remain in `memory-engine` and `memory_recall`.

Longer-term research has separate owners:

1. Growth decides whether an observed knowledge gap merits research. An
   explicit user request is direct authorization; ambient interests are
   scored for recurrence and value.
2. Planner's research profile scopes Growth-approved work. It can use saved
   knowledge and bounded web search, and returns a structured brief.
3. The Research agent in `knowledge-engine` investigates that brief and
   creates or updates the durable knowledge document.

Amy's immediate lookup tool does not enqueue research. The old
`research_task` MCP tool remains registered for compatibility but is not in
Amy's chat tool groups.

## Planner reuse

Planner is a bounded, invoked capability with research and coding profiles,
not an autonomous service. Growth's Python adapter and Coding Orchestrator's
TypeScript adapter share the documented structured contract in
[`planner-agent.md`](planner-agent.md), without adding a container. The
owning workflow controls approval and execution. The Coding Orchestrator
continues to run Planner → Coder → Tester → Reviewer.

## Services

- `agent-service`: live chat runtime, context assembly, and Growth lifecycle.
- `skills-mcp`: MCP tools and integration adapters.
- `knowledge-engine`: document ingestion, hybrid retrieval, web passage
  retrieval, asynchronous Research agent, and research queue.
- `memory-engine`: cross-conversation personal memory retrieval.
- `event-bus`: event intake, goals, task contexts, and digest scheduling.
- `coding-orchestrator` and `sandbox-runner`: isolated code-task planning and
  execution; `openhands-runner` is an optional execution backend.
- `graphiti-service`: graph-backed project, decision, and Growth history.
- `scrapling-service`: web-page fetching/extraction used by research.
- `n8n`: remaining automation workflows and the rollback chat workflow.
- Postgres and Redis: durable service databases and short-term chat history.

See the service-specific documents in `docs/` for schemas, runtime details,
and operational procedures. [`README.md`](../README.md) describes the
repository layout.
