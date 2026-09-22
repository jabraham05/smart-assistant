# Ops dashboard

Part of the [Smart Assistant](../README.md) project — see the README for the
project overview, setup instructions, and directory layout.

A single-pane-of-glass monitoring UI for the whole stack, at
`http://localhost:3006` (LAN-only, no auth, same trust boundary as every
other service here). Built because understanding "what happened for this
message" previously meant separately checking n8n's UI, `docker logs`, and
ad-hoc Postgres queries — the exact manual process used throughout this
project's own MCP tool-name-prefix bug investigation (see
`chat-workflow.md`'s 2026-09-20 entries).

Same stack as `chat-ui` (Next.js App Router + React + TypeScript + Tailwind,
standalone Docker build), for consistency.

## Panels

- **Activity** (`/activity`, the default landing page) — a polling
  (every 5s) system-monitor feed, merging the `events` database's `events`
  table, n8n's `execution_entity`, and `event-bus`'s own
  `GET /goals?status=active` / `GET /task-contexts?status=open` endpoints
  into one reverse-chronological timeline. Nothing in this stack has a
  pubsub/SSE/WebSocket layer, so this polls with a cursor rather than
  subscribing.
- **Chat** (`/chat`) — embeds `chat-ui` in an iframe. Covers both live chat
  and Honcho-backed session history in one panel, since `chat-ui` already
  has both - no separate chat code needed here.
- **Workflows** (`/workflows`) — a link-out to n8n's editor (it sends
  `X-Frame-Options: SAMEORIGIN`, confirmed live, so it can't be iframed),
  plus a custom recent-executions list and a per-execution drill-down that
  decodes `execution_data.data` with the plain `flatted` npm package to
  show every node's run: status, duration, and its actual input/output
  (including real tool-call arguments/results for AI sub-nodes like
  "MCP Client Tool", which connect via n8n's `ai_tool`/`ai_languageModel`
  connection types rather than the standard `main` data flow).
- **Agent Registry** (`/registry`) — no single registry exists anywhere in
  the stack, so this assembles one from 3 real sources: `skills-mcp`'s live
  MCP `tools/list` (the same connection pattern as
  `scripts/verify-tool-schema-compat.mjs`), the `Chat` workflow's hardcoded
  capability→tool `GROUPS` mapping (read live from the `n8n` database's
  `workflow_entity` row, not a checked-in file, via a narrow regex over its
  known shape - deliberately never `eval`s the Code node's `jsCode`), and
  `coding-orchestrator`'s 4 fixed roles (Planner/Coder/Tester/Reviewer -
  hardcoded here since there's no dynamic discovery possible).
- **Database** (`/database`) — a multi-database SQL query panel
  (`postgres | n8n | research | coding_tasks | events`, the 5 real
  databases on the shared Postgres container). No dedicated read-only
  Postgres role exists across them, so safety is enforced two independent
  ways: an app-layer check rejecting anything but a single `SELECT`/`WITH`
  statement, and (the real safety boundary) executing inside a genuine
  `BEGIN TRANSACTION READ ONLY` with a 5s statement timeout.
- **Knowledge Search** (`/knowledge`) — a thin proxy to
  `knowledge-engine`'s `POST /search`, the exact same hybrid
  vector+keyword retrieval the `knowledge_search` tool itself uses.
- **Logs** (`/logs`) — a service dropdown + manual-refresh tail viewer via
  `dockerode` (mounts `/var/run/docker.sock`, same precedent as
  `sandbox-runner`), resolving containers by their
  `com.docker.compose.service` label rather than a hardcoded container
  name.
- **Docs** (`/docs`) — this page, and the rest of `docs/` + the root
  `README.md`, rendered with `react-markdown`.

## Known constraints

- **Docs are baked into the image at build time, not live-mounted.**
  Confirmed live that both a single-file bind mount and a directory bind
  mount get stuck as empty on this machine's Docker Desktop - the same
  failure mode already documented for `skills-mcp`'s Google Calendar key
  file. A doc edit needs `docker compose up -d --build dashboard` to show
  up. This is also why `dashboard`'s build context is the repo root
  (`dashboard/Dockerfile` needs to `COPY docs/` and `README.md`, which are
  outside its own directory) - every other service here uses its own
  subdirectory as context.
- **No auth.** LAN-only by design, same trust boundary as `n8n`/`chat-ui`.
  The Database panel can run arbitrary read queries, including against
  tables with real personal data (chat history, calendar events, etc.).
- **The registry's GROUPS parsing is inherently reading someone else's live
  implementation detail** (the `Chat` workflow's Code node). If that node's
  code shape changes significantly, the panel shows a clear error rather
  than crashing, but the mapping itself needs a matching update in
  `dashboard/src/lib/n8n-groups.ts`.
