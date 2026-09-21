# Smart Assistant

A self-hosted, self-learning personal AI assistant. n8n orchestrates a local
Ollama model as the "brain," Honcho (hosted cloud) provides long-term memory
of who you are, and postgres/redis back everything. Long-term goal: an
ever-growing library of skills (n8n workflows), a background job that
proposes new skills on its own (with a human approval gate before anything
goes live), and a Raspberry Pi voice interface. A Raspberry Pi smart-mirror
dashboard is already live — Amy is its data source and controller (see
[`docs/smart-mirror-dashboard.md`](docs/smart-mirror-dashboard.md)); voice
control works end-to-end except the actual microphone/wake-word leg, still
unbuilt hardware-wise.

This README covers setup and directory layout. Everything else —
architecture, and each individual system's design/history/gotchas — lives
under [`docs/`](docs/), one file per system, so each piece can be read (and
eventually tested) on its own.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — project-wide service
  overview (n8n, skills-mcp, Ollama, Honcho, postgres, redis)
- [`docs/chat-workflow.md`](docs/chat-workflow.md) — the main `Chat` n8n
  workflow: pipeline diagram, tool-calling reliability saga, trigger/response
  mode gotchas (superseded for real traffic by `chat-orchestrator`, kept
  published as the rollback — see below)
- [`docs/chat-orchestrator.md`](docs/chat-orchestrator.md) — self-hosted
  replacement for the `Chat` workflow's tool-calling: a raw Ollama
  tool-calling loop against a real MCP client, what `chat-ui`/
  `discord-bot` actually talk to now
- [`docs/honcho-memory.md`](docs/honcho-memory.md) — Honcho peer cards
  (proactive memory + behavioral instructions for Amy)
- [`docs/persona-system.md`](docs/persona-system.md) — Amy's identity,
  tool-count/naming decisions, persona-prompt fixes
- [`docs/event-bus-and-goals.md`](docs/event-bus-and-goals.md) — event
  ingestion, classification, goal tracking + stale-goal nudges
- [`docs/idle-reflection.md`](docs/idle-reflection.md) — autonomous
  proactive check-in, work-level- and cooldown-gated
- [`docs/skill-proposals.md`](docs/skill-proposals.md) — reactive
  self-authoring skills (`skill_propose`), human-gated
- [`docs/skill-gap-scanner.md`](docs/skill-gap-scanner.md) — autonomous
  self-reflection (`skill_gap_scanner`), human-gated
- [`docs/coding-agent-pipeline.md`](docs/coding-agent-pipeline.md) — plans,
  writes, and tests real code changes in an isolated sandbox
- [`docs/smart-mirror-dashboard.md`](docs/smart-mirror-dashboard.md) —
  Raspberry Pi dashboard + voice
- [`docs/home-assistant.md`](docs/home-assistant.md) — self-hosted Home
  Assistant, phone-presence tracking
- [`docs/discord-bridge.md`](docs/discord-bridge.md) — Discord DM client
- [`docs/knowledge-engine.md`](docs/knowledge-engine.md) — document
  ingestion, hybrid retrieval + citations, and web research (replaces the
  old research workflow)
- [`docs/research-workflow.md`](docs/research-workflow.md) — superseded,
  kept for history
- [`docs/known-gotchas.md`](docs/known-gotchas.md) — generic n8n/Docker/
  tooling gotchas not specific to any one system above

## Directory layout

- `docker-compose.yml` — the whole stack.
- `docs/` — per-system documentation (see [Documentation](#documentation)
  above). One file per system; the README stays limited to setup and this
  layout.
- `postgres/init/` — one-time DB init scripts (creates the `n8n` database
  and, as of `02-create-research-db.sql`, the `research` database +
  pgvector extension; `08-create-knowledge-tables.sql` and
  `09-add-domain-skills-table.sql` add the knowledge-engine's tables to
  that same `research` database. Runs once against an empty volume
  only — see [`docs/knowledge-engine.md`](docs/knowledge-engine.md) for
  the manual-migration command needed on an already-existing volume like
  this project's).
- `n8n/workflows/` — exported workflow JSON, for history/diffing. Edit
  workflows in the n8n UI, then run `scripts/export-n8n-workflows.sh`.
- `chat-ui/` — Next.js custom web chat client, wired into
  `docker-compose.yml` (builds from `chat-ui/Dockerfile`, serves on
  `:3000`). Proxies chat through the n8n webhook and reads session
  list/history from Honcho.
- `discord-bot/` — Discord DM bridge, another thin client of the same Chat
  webhook (see [`docs/discord-bridge.md`](docs/discord-bridge.md)).
- `skills-mcp/` — MCP server hosting agent-callable tools
  (`memory_recall`, `weather_get`, `skill_propose`, `calendar_event`,
  `code_task`, `spotify_control`, `dashboard_control`, `web_search`,
  `knowledge_search`, `knowledge_ingest`, `research_task`,
  `research_task_status`, `goal_manage`, `calculate`),
  plus internal (non-MCP) routes `/internal/dashboard-data` and
  `/internal/spotify-action` (see
  [`docs/smart-mirror-dashboard.md`](docs/smart-mirror-dashboard.md)),
  wired into `docker-compose.yml` (builds from `skills-mcp/Dockerfile`,
  internal-only, no published port). n8n's `Chat` workflow reaches it via an
  `MCP Client Tool` node.
- `knowledge-engine/` — document ingestion, hybrid (vector + keyword)
  retrieval with first-class citations, and web research (see
  [`docs/knowledge-engine.md`](docs/knowledge-engine.md)); reuses the
  `research` Postgres database, internal-only, no published port.
- `event-bus/` — event ingestion, deterministic classification, and
  deterministic goal-matching (see
  [`docs/event-bus-and-goals.md`](docs/event-bus-and-goals.md)); its own
  dedicated `events` Postgres database, internal-only, no published port.
- `homeassistant/` — self-hosted Home Assistant config (see
  [`docs/home-assistant.md`](docs/home-assistant.md)); only
  `configuration.yaml`/`automations.yaml`/`scripts.yaml`/`scenes.yaml`/
  `secrets.yaml`/`blueprints/` are tracked, everything else under
  `homeassistant/config/` is gitignored runtime state.
- `sandbox-runner/` — Docker-outside-of-Docker sandbox for the coding-agent
  pipeline (see
  [`docs/coding-agent-pipeline.md`](docs/coding-agent-pipeline.md));
  `base-images/node/` is the custom image its ephemeral containers run.
- `coding-orchestrator/` — owns the coding-agent pipeline's actual
  Planner→Coder→Tester→Reviewer→retry state machine as real TypeScript
  (see the "architectural rethink" dated entry in
  [`docs/coding-agent-pipeline.md`](docs/coding-agent-pipeline.md)); n8n
  keeps only a thin submit/status webhook proxy in front of it.
- `scripts/start-coding-task.mjs` — explicit trigger for the coding-agent
  pipeline, mirroring `chat.mjs`'s role as a reference client for the
  `Chat` webhook.
- `chat-orchestrator/` — self-hosted tool-calling for real chat traffic,
  replacing the `Chat` workflow's `AI Agent`/`MCP Client Tool` node (see
  [`docs/chat-orchestrator.md`](docs/chat-orchestrator.md)); runs as two
  instances (`chat-orchestrator` prod, `chat-orchestrator-test`) differing
  only by env var (Redis DB index, Postgres schema for persona/skills
  reads). `chat.mjs` can be pointed at either directly via
  `N8N_CHAT_WEBHOOK_URL=http://localhost:3008/webhook` (prod) or `:3009`
  (test) with no script changes, since the NDJSON contract is identical.
- `honcho-src/` — a clone of the Honcho OSS repo from when self-hosting was
  attempted. Unused now that Honcho runs hosted. Gitignored; safe to delete,
  kept only in case self-hosting is revisited (cost/privacy reasons).
- `scripts/` — `pull-models.sh` (pull required Ollama models),
  `export-n8n-workflows.sh` (see above), `chat.mjs` (CLI connectivity test /
  reference client — see below), `set-peer-cards.mjs` (one-time Honcho peer
  card bootstrap — see [`docs/honcho-memory.md`](docs/honcho-memory.md)),
  `benchmark-models.mjs`
  (benchmarks local Ollama models directly against the Ollama API — bypasses
  n8n — on tool-calling accuracy, general accuracy, and latency; writes
  JSON+Markdown reports to `benchmark-results/`, which backs the specific
  model-comparison numbers referenced in
  [`docs/chat-workflow.md`](docs/chat-workflow.md)'s tool-calling gotcha).

## Setup

1. `cp .env.example .env` and fill in `POSTGRES_PASSWORD` (any strong
   random string) and `N8N_ENCRYPTION_KEY` (any strong random string).
2. `docker compose up -d`
3. **For the coding-agent sandbox** (see
   [`docs/coding-agent-pipeline.md`](docs/coding-agent-pipeline.md)):
   `docker network create sandbox-net` and `docker build -t
   sandbox-node-test:latest ./sandbox-runner/base-images/node`. Neither
   happens automatically — compose only auto-creates a network when some
   service's `networks:` list structurally attaches to it, and
   `sandbox-runner` only references `sandbox-net` by name (as the network
   its *spawned* containers join, not one it joins itself), so compose
   never sees it as "used." The base image is a plain `docker build`, not
   a compose service, for the same reason. Skip this if you're not using
   the coding-agent pipeline yet.
4. `bash scripts/pull-models.sh` — pulls `llama3.1:8b` and `nomic-embed-text`
   (`nomic-embed-text` was originally pulled for an abandoned self-hosted-Honcho
   attempt and sat unused; it's now genuinely load-bearing again, as the
   embedding model behind the knowledge engine's `chunks.embedding`
   column — see [`docs/knowledge-engine.md`](docs/knowledge-engine.md)).
   This script is stale re: the *actual* chat model — the `Chat`
   workflow's `Ollama Chat Model` node is user-configured and has already
   moved on from `llama3.1:8b` (see
   [`docs/chat-workflow.md`](docs/chat-workflow.md)'s tool-calling gotcha);
   pull whatever model you actually configure there yourself, e.g.
   `docker compose exec ollama ollama pull qwen3:8b`. `OLLAMA_WARMUP_MODEL`
   (default `llama3.2:3b`) is a separate, independent setting — keep it in
   sync with whatever the Chat workflow actually uses, or the warmup step
   preloads the wrong model.
5. Open n8n at http://localhost:5678, create an owner account, build/import
   the Chat workflow (see `n8n/workflows/` for the last exported copy — check
   its `updatedAt` against the live workflow in n8n before trusting it; see
   [`docs/known-gotchas.md`](docs/known-gotchas.md)).
6. On the Chat Trigger node: **Mode must be "Webhook"**, not "Hosted Chat"
   (see [`docs/chat-workflow.md`](docs/chat-workflow.md)). Toggle the
   workflow **Active**.
7. Add a Honcho API key as an n8n credential (HTTP Bearer Auth type) — get
   a key at [app.honcho.dev](https://app.honcho.dev) ($100 free credits to
   start). Never put this key in a file; n8n's credential vault is the only
   place it should live.
8. Optionally set `HOME_LOCATION` (a city name) or `HOME_LATITUDE`/
   `HOME_LONGITUDE` in `.env` so the `weather_get` tool has a default when
   the user doesn't name a city. Without this, `weather_get` still works for
   an explicitly named location, but returns a clear error (not a crash) if
   asked for "the weather" with no location given and none configured.
9. Optionally bootstrap the Honcho peer cards (see
   [`docs/honcho-memory.md`](docs/honcho-memory.md)) by editing the fact
   lists in `scripts/set-peer-cards.mjs` and running `HONCHO_API_KEY=...
   node scripts/set-peer-cards.mjs`. Not required — both cards start empty
   and fill in over time via Honcho's automatic dreaming — but this skips
   the cold-start gap.
10. Optionally set up `calendar_event` (Google Calendar). Create a Google
    Cloud project, enable the Calendar API, create a service account
    (IAM & Admin → Service Accounts → Create), generate a JSON key for it
    (Keys tab → Add Key → Create new key → JSON), and save that file as
    `skills-mcp/secrets/google-calendar-key.json` (gitignored) — **baked
    into the image at build time, not bind-mounted** (see
    [`docs/known-gotchas.md`](docs/known-gotchas.md)), so run `docker
    compose up -d --build skills-mcp` after adding it, a plain restart
    won't pick it up. Share the target calendar with the service
    account's `client_email` (Google Calendar → calendar settings →
    "Share with specific people" → "Make changes to events"), then set
    `GOOGLE_CALENDAR_ID` in `.env` (your Gmail address for your primary
    calendar, or the calendar's ID from "Integrate calendar"). Without
    this, `calendar_event` returns a clear "not configured" error rather
    than breaking anything.
11. Optionally start Home Assistant for phone-presence tracking — see
    [`docs/home-assistant.md`](docs/home-assistant.md).

## Testing connectivity

```powershell
$env:N8N_CHAT_WEBHOOK_URL = "http://localhost:5678/webhook/<your-webhook-id>/chat"
node scripts/chat.mjs "hey, are you there?"
```

Persists a session id locally (`.chat-session-id`, gitignored) so follow-up
messages stay in the same conversation. This CLI was also a rough
prototype of what the Pi's voice-command route now actually does: POST
transcribed text in, get reply text back (see
[`docs/smart-mirror-dashboard.md`](docs/smart-mirror-dashboard.md)) — the
prototype's shape held up unchanged.

## Not built yet (by design, deferred)

- `update_context` workflow — currently an empty stub, no nodes.
- Actually deleting the two `propose_persona_change` workflow entities in
  n8n. They're fully unpublished/inactive (dead — see
  [`docs/persona-system.md`](docs/persona-system.md)) but n8n's CLI has no
  `delete:workflow` command, and hacking the DB directly to remove them
  risks the kind of draft/publish corruption documented in
  [`docs/known-gotchas.md`](docs/known-gotchas.md). Delete both via the n8n
  UI (Workflows list → ⋮ menu → Delete) when convenient. Until then,
  `list:workflow` still enumerates them, so `export-n8n-workflows.sh` will
  keep regenerating their JSON as draft-fallback exports in
  `n8n/workflows/` — harmless, just noise, delete those files again after
  the real deletion goes through.
- Fully suppressing the rare live `{}` flash (buffer-then-respond instead of
  token streaming) — see [`docs/chat-workflow.md`](docs/chat-workflow.md)'s
  tool-calling gotcha.
- On-demand/progressive-disclosure loading for active instruction skills
  (a `use_skill` tool call instead of always injecting every active skill's
  full text into every turn) — only worth building once the always-inject
  approach actually causes prompt bloat with a larger skill library, not
  before.
- Actual code generation/implementation for `tool_idea` proposals via
  `skill_propose`/`skill_gap_scanner` themselves — this is now being
  actively worked on, just via a separate mechanism (see
  [`docs/coding-agent-pipeline.md`](docs/coding-agent-pipeline.md)), not by
  extending those two directly.
- Raspberry Pi voice client's mic-to-text leg — see
  [`docs/smart-mirror-dashboard.md`](docs/smart-mirror-dashboard.md).
  Text-in → Chat webhook → TTS-out is fully working;
  `voice-daemon/listener.py` (openWakeWord + whisper.cpp, no Wyoming — see
  that doc for why) is staged but untested, blocked on a microphone
  actually being attached to the Pi.
- Goal-completion detection and persona-driven nudge tone/frequency for
  the stale-goal nudge — see
  [`docs/event-bus-and-goals.md`](docs/event-bus-and-goals.md).
- Documentation for `event-bus/src/calendar-watch.ts` (the calendar
  poll-and-diff watcher) — a known gap, not a sign it's unused.
- Automated test suites for most services. `event-bus` has a first one now
  (`classify.ts`/`goal-matching.ts`'s pure logic, via Node's built-in test
  runner — see [`docs/event-bus-and-goals.md`](docs/event-bus-and-goals.md))
  but `coding-orchestrator`, `sandbox-runner`, `skills-mcp`, `chat-ui`, and
  `discord-bot` still have none — every "verified" claim for those is
  manual/live testing against the real stack. Next planned piece of work,
  one service at a time.
