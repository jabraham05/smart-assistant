# `chat-orchestrator` — self-hosted tool-calling for Chat, replacing n8n's AI Agent

Part of the [Smart Assistant](../README.md) project. See
[`docs/chat-workflow.md`](chat-workflow.md) for the n8n workflow this
replaces (kept published as a rollback, not deleted) and
[`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md) for the
raw-Ollama-tool-loop pattern this reuses.

**2026-09-21 — built because n8n's `AI Agent` + `MCP Client Tool` node is
the one integration in this whole project with an extensive, unresolved
history of `qwen3:8b` tool-calling failures** (see
[`docs/chat-workflow.md`](chat-workflow.md)'s and
[`docs/persona-system.md`](persona-system.md)'s documented history: empty
completions, self-contradictory reasoning that never emits a call, leaked
internal tool/node names, and `skill_propose`'s own irreducible
invocation gap). `coding-orchestrator` and `knowledge-engine`'s research
agent had already independently proven a raw Ollama `/api/chat`
tool-calling loop reliable for this exact model — this ports that same
proven pattern to Chat, via a real MCP client against `skills-mcp`
(itself completely unchanged — it was already a correctly-separated,
standalone MCP server; this is just a second, better-behaved consumer of
it).

**Root cause, precisely** (this determined what got ported vs. dropped):
`docs/chat-workflow.md` documents a real, controlled, client-independent
finding that `qwen3:8b` itself gets measurably worse at tool selection as
bound tool count grows (0/3 success with 6 tools bound vs. 3/3 with 1,
tested via `ollama-mcp-bridge` bypassing n8n entirely, and via n8n's
native path — same result either way). `coding-orchestrator`'s own
raw-HTTP validation only ever tested 2 tools, so it's consistent with
this, not a contradiction of it. Separately, two genuinely n8n-specific
bugs stack on top: the `MCP Client Tool` node prefixes tool names with
its own node display name, silently breaking `qwen3:8b`'s tool-calling
grammar once the combined name crosses ~5-6 segments
([`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md)); and
`lmChatOllama` loses the `tool_calls` field whenever a response carries a
`thinking` block. Moving off n8n's integration removes the two
n8n-specific bugs, but **not** the underlying tool-count ceiling — the
dynamic tool-group classifier is ported forward deliberately, not
dropped.

## Architecture

New service, `chat-orchestrator/` (Node/Express, same shape as
`coding-orchestrator/`/`knowledge-engine/`). Preserves the exact wire
contract both real clients (`chat-ui`, `discord-bot`) already parse:
`POST /webhook` with `{chatInput, sessionId}`, NDJSON stream out
(`{type: "begin"|"item"|"end"|"error", content?, metadata: {nodeId,
nodeName, itemIndex, runIndex, timestamp}}`), reply text always carrying
the literal `metadata.nodeName: "AI Agent"` both clients already key off
of. This is why the client cutover needed **zero code changes** in either
`chat-ui` or `discord-bot` — only their webhook URL env var moved.

Per-turn pipeline (`src/index.ts`):

1. Fire-and-forget event to `event-bus` (`src/events.ts`).
2. **Tool-group classification** (`src/classify-tools.ts`) — ported
   near-verbatim from the old `Classify Relevant Tool Groups`/
   `Expand Groups To Tools` nodes: same category list, same `GROUPS`
   mapping, same raw-Ollama structured-output call. `calculate` always
   included. Kept because it's mitigating the real tool-count ceiling
   above, not an n8n-specific workaround.
3. **Persona + active instruction skills** (`src/db.ts`,
   `src/skills-catalog.ts`) — direct Postgres reads against a
   schema-configurable view (`CHAT_DB_SCHEMA`: `public` in production,
   `chat_test` for the side-by-side test instance — see
   `postgres/init/10-add-chat-test-schema.sql`). Read-only: approving a
   skill or editing a persona still happens exactly where it does today,
   in n8n's Data Table UI (or directly via SQL in `chat_test` while
   trying something out).
4. **Honcho calls** (`src/honcho.ts`) — ported verbatim: ensure session,
   set `observe_others` on peer `user`, get `user`'s card, get `user`'s
   card `target=amy`. Same workspace as production n8n
   (`smart-assistant`) for both the prod and test instance — a known,
   accepted limitation (see below).
5. **System prompt assembly** (`src/system-prompt.ts`) — same shape as
   the old `AI Agent.systemMessage` expression: persona + Pacific-time
   date injection + user card + user-for-amy card + skills catalog, each
   clause degrading to empty string if its source is missing.
6. **Raw Ollama tool-calling loop** (`src/agent-loop.ts`) — the exact
   `coding-orchestrator/src/agent-loop.ts` shape (structural
   `message.tool_calls` detection, `trimHistoryToBudget`/
   `truncateToolResult`), extended to accept short-term conversation
   history as a permanently-protected block ahead of the current
   turn, and to report which tools were actually called each iteration
   (`onToolCalls`) so the safety net below can check real behavior, not
   just the final text. Tools come from a real MCP client
   (`src/mcp-client.ts`, `@modelcontextprotocol/sdk`) connected to
   `http://skills-mcp:3001/mcp?chatSessionId=...` — same endpoint and
   same session-correlation query param the old `MCP Client Tool` node
   used — filtered to the classified subset from step 2.
7. **Minimal safety net** (`src/safety-net.ts`) — only the
   mechanism-independent checks survive from the old `Detect Garbage
   Output` node. The old regex zoo (leaked MCP error strings, leaked
   internal node/tool names, fake tool-call JSON blobs, "function call"
   narration) was specifically symptomatic of the two n8n bugs this
   migration removes — a structurally-detected `tool_calls` response
   can't produce those shapes. What's kept: one-shot empty-output retry
   (mirrors `coding-orchestrator`'s own retry), one-shot
   unfulfilled-search-intent retry (model narrates "let me search..."
   without an actual search tool call), and a one-shot confabulated-action
   retry (model claims "I've scheduled that" with no matching tool call).
8. **Persist**: Honcho (`peer_id: 'user'`/`'amy'`, same as before) and the
   service's own Redis-backed short-term buffer (`src/session-memory.ts`,
   `REDIS_DB`: `0` prod / `1` test) — replaces n8n's Postgres Chat Memory
   for chat specifically. Neither `chat-ui` nor `discord-bot` ever read
   `n8n_chat_histories` directly (confirmed: it was purely internal to the
   old `AI Agent`'s own prompt construction), so retiring it for chat had
   no client-visible effect.

## Test/production separation

Two docker-compose services from the same image, differing only by env
var: `chat-orchestrator` (prod, host port 3008 → container 3006) and
`chat-orchestrator-test` (host port 3009 → container 3006). No
per-request flag, no shared mutable state. `REDIS_DB` keeps session
buffers from colliding; `CHAT_DB_SCHEMA` points persona/skills reads at
either the real views onto n8n's live Data Tables or the plain
`chat_test.personas`/`chat_test.skills` tables a human can freely edit via
SQL to try a change safely before promoting it into the real n8n Data
Table via the UI.

**Known, accepted limitation**: both instances share one real Honcho
workspace, `skills-mcp`, and Ollama. A test-mode conversation still
writes to Amy's real long-term Honcho memory, and a real tool call
(schedule a calendar event, control Spotify) still performs the real
action — not sandboxed by this design, deliberately out of scope for this
phase.

## Verified live (2026-09-21)

Against the real running stack, not just the 21 unit tests covering the
pure/deterministic pieces (`classify-tools`, `safety-net`, `agent-loop`'s
trim/truncate, `skills-catalog`, `system-prompt`):

- Plain greeting, zero tools bound.
- A real `weather_get` tool call (single tool) — genuine Open-Meteo data
  back through the model, not confabulated.
- A combined `calculate` + `weather_get` call in **one turn** (two-group
  classification, `qwen3:8b` correctly emitting two simultaneous
  `tool_calls`).
- Multi-turn Redis session memory recall ("my favorite number is 42" →
  "what's my favorite number?" correctly answered "42" in a fresh
  process/session two calls later).
- Test/prod isolation: edited `chat_test.personas` alone (a literal
  `TESTMODE` marker), confirmed `chat-orchestrator-test` reflected it
  while `chat-orchestrator` (prod) and the real n8n persona stayed
  exactly unchanged.
- **Client cutover**: `chat-ui`'s real `/api/chat` route and
  `discord-bot` both repointed at `chat-orchestrator` (prod) via env var
  only, zero code changes. `chat-ui`'s route round-tripped a real
  `calculate` tool call end-to-end through the new backend; `discord-bot`
  reconnected to Discord's gateway cleanly under the new URL.

## What's explicitly NOT changing (yet)

- **n8n itself is not being retired.** It still runs 10 other active
  workflows unrelated to this migration: `calendar_watch`,
  `coding_task_orchestrator_proxy`, `dashboard_control`,
  `dashboard_state`, `goals_stale_nudge`, `idle_reflection`,
  `minimal_agent_test`, `skill_gap_scanner`, `skill_proposal_intake` (the
  actual webhook target `skill_propose` posts to), and `spotify_action`.
  Confirmed directly against the live `workflow_entity` table
  (`active = true` for all of these) before writing this section.
- **The old `Chat` workflow is deliberately still published**, as the
  literal instant rollback: reverting `chat-ui`/`discord-bot`'s webhook
  URL env var back to
  `http://n8n:5678/webhook/370d9565-997b-4121-aca7-1128df3dc4ea/chat` is
  the entire rollback procedure, with no import/publish cycle needed.
  `coding-orchestrator`'s and `event-bus`'s direct writes into
  `n8n_chat_histories` (via `notifySession`, see
  [`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md) and
  [`docs/event-bus-and-goals.md`](event-bus-and-goals.md)) are **also**
  deliberately still in place for the same reason — removing them now
  would let the rollback path's own conversation memory silently go
  stale from the moment of cutover onward. **Revisit trigger**: once
  `chat-orchestrator` has had a real soak period with no regressions, at
  which point unpublishing `Chat` (same `unpublish:workflow` +
  `webhook_entity` cleanup procedure already used for `research_pipeline`/
  `coding_task_pipeline`, see
  [`docs/known-gotchas.md`](known-gotchas.md)) and removing the
  `n8n_chat_histories` dual-writes become safe, not premature.
- `skills-mcp` — unchanged; now a shared tool host for three consumers
  (`coding-orchestrator`, `knowledge-engine`, `chat-orchestrator`) instead
  of two.
