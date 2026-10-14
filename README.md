# Smart Assistant

A self-hosted, self-learning personal AI assistant. `agent-service`
(Python/PydanticAI) is the live Coordinator orchestrating a local Ollama
model as the "brain" against real tools (`skills-mcp`); n8n's original
`Chat` workflow still exists only as the outermost rollback (see
[`docs/chat-workflow.md`](docs/chat-workflow.md) and
[`docs/agent-service.md`](docs/agent-service.md)). Honcho (hosted cloud)
provides long-term memory of who you are, and postgres/redis back
everything. Long-term goal: an ever-growing library of skills, a
background job that proposes new skills on its own (with a human approval
gate before anything goes live — now generalized into the Growth engine,
see [`docs/growth-engine.md`](docs/growth-engine.md)), and a Raspberry Pi
voice interface. A Raspberry Pi smart-mirror dashboard is already live —
Amy is its data source and controller (see
[`docs/smart-mirror-dashboard.md`](docs/smart-mirror-dashboard.md)); voice
control works end-to-end except the actual microphone/wake-word leg, still
unbuilt hardware-wise. A native iOS app (see
[`docs/native-ios-app-plan.md`](docs/native-ios-app-plan.md)) is also live
for chat, the Home dashboard, and Amy Lab/Growth/Memory.

This README covers setup and directory layout. Everything else —
architecture, and each individual system's design/history/gotchas — lives
under [`docs/`](docs/), one file per system, so each piece can be read (and
eventually tested) on its own.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — project-wide service
  overview (n8n, skills-mcp, Ollama, Honcho, postgres, redis)
- [`docs/chat-workflow.md`](docs/chat-workflow.md) — the main `Chat` n8n
  workflow: pipeline diagram, tool-calling reliability saga, trigger/response
  mode gotchas (superseded for real traffic by `agent-service`, kept
  published as the rollback — see below)
- [`docs/chat-orchestrator.md`](docs/chat-orchestrator.md) — **retired and
  deleted, 2026-10-13** (kept for history); was the self-hosted replacement
  for the `Chat` workflow's tool-calling and the **Coordinator** built on
  top of it, superseded by `agent-service` (a Python/PydanticAI port of the
  same Coordinator). Originally left running as a middle rollback layer,
  but that rollback was never needed, so the service and its source
  directory were removed outright — see `docs/unified-architecture-gap-analysis.md`
- [`docs/agent-service.md`](docs/agent-service.md) — PydanticAI/Python port
  of the Coordinator, the live chat backend; architecture, config,
  rollback instructions, and the real streaming bug found standing it up
- [`docs/unified-architecture-gap-analysis.md`](docs/unified-architecture-gap-analysis.md)
  — conceptual design reference for the "5-pillar rebuild"
  (PydanticAI → OpenHands → Graphiti → Scrapling → DSPy) that produced
  `agent-service`, `openhands-runner`, `graphiti-service`,
  `scrapling-service`, and `dspy-optimizer`; maps the rebuild against a
  proposed unified architecture and tracks the real gaps (a unified
  Growth lifecycle, first-class dynamically-loaded skills)
- [`docs/growth-engine.md`](docs/growth-engine.md) — `agent-service`'s
  self-improvement lifecycle: turn-logging → opportunity scoring →
  proposals → experiments/evaluations → human-gated consolidation, plus
  the Teaching layer and the Amy Lab dashboard that surfaces all of it
- [`docs/dspy-optimizer.md`](docs/dspy-optimizer.md) — offline, non-live
  few-shot optimizer for `agent-service`'s tool-group classifier prompt;
  a human-run tool, not a runtime dependency
- [`docs/scrapling-service.md`](docs/scrapling-service.md) — real page
  fetching/extraction (JS rendering, anti-bot evasion) backing
  `knowledge-engine`'s web research
- [`docs/memory-engine.md`](docs/memory-engine.md) — self-hosted
  cross-conversation memory (hybrid ranked search, no LLM in the hot
  path), the Coordinator's `memoryPolicy` backend
- [`docs/chat-ui.md`](docs/chat-ui.md) — the Next.js chat client: the
  session-sidebar fix (Discord conversations were sorting to the bottom,
  unlabeled) and the read-only event-bus visibility panel
- [`docs/honcho-memory.md`](docs/honcho-memory.md) — Honcho peer cards
  (proactive memory + behavioral instructions for Amy); narrowed to
  profile/consolidation only now that cross-conversation retrieval lives
  in `memory-engine`
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
- [`docs/native-ios-app-plan.md`](docs/native-ios-app-plan.md) — the real
  SwiftUI app (`ios/`), pivoted away from the installable-PWA path; chat,
  Home dashboard, and Amy Lab/Growth/Memory milestones are live, voice
  (push-to-talk) hasn't started yet
- [`docs/iphone-pwa-implementation-plan.md`](docs/iphone-pwa-implementation-plan.md)
  — superseded by the native iOS pivot above, kept for history (some
  recommendations did ship into `chat-ui` — bearer-token auth, PWA
  manifest/icons, the responsive `AppDrawer`)
- [`docs/home-assistant.md`](docs/home-assistant.md) — self-hosted Home
  Assistant, phone-presence tracking
- [`docs/discord-bridge.md`](docs/discord-bridge.md) — Discord DM client
- [`docs/knowledge-engine.md`](docs/knowledge-engine.md) — document
  ingestion, hybrid retrieval + citations, web research (replaces the old
  research workflow), and the self-learning research queue that drains
  during idle/overnight time
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
  `drive_search`, `code_task`, `spotify_control`, `dashboard_control`,
  `web_search`, `knowledge_search`, `knowledge_ingest`, `research_task`,
  `research_task_status`, `goal_manage`, `task_context_manage`,
  `status_overview`, `project_propose`, `project_complete`,
  `growth_review`, `teaching_session_manage`, `skill_examples`,
  `calculate`), plus internal (non-MCP) routes `/internal/dashboard-data` and
  `/internal/spotify-action` (see
  [`docs/smart-mirror-dashboard.md`](docs/smart-mirror-dashboard.md)),
  wired into `docker-compose.yml` (builds from `skills-mcp/Dockerfile`,
  internal-only, no published port). `agent-service` reaches it via a real
  MCP client; n8n's `Chat` workflow (the rollback) reaches it via an
  `MCP Client Tool` node.
- `knowledge-engine/` — document ingestion, hybrid (vector + keyword)
  retrieval with first-class citations, and web research (see
  [`docs/knowledge-engine.md`](docs/knowledge-engine.md)); reuses the
  `research` Postgres database, internal-only, no published port.
- `event-bus/` — event ingestion, deterministic classification,
  deterministic goal-matching, TaskContext steps, and the overnight
  digest/calendar-wake pipeline (see
  [`docs/event-bus-and-goals.md`](docs/event-bus-and-goals.md)); its own
  dedicated `events` Postgres database, internal-only, no published port.
- `memory-engine/` — self-hosted cross-conversation memory: hybrid
  (vector + keyword + recency) ranked search, no LLM anywhere in its hot
  path (see [`docs/memory-engine.md`](docs/memory-engine.md)); its own
  dedicated `memory` Postgres database, internal-only, no published port.
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
- `agent-service/` — Python/PydanticAI port of the Coordinator (a
  TypeScript service called `chat-orchestrator`, now retired and deleted —
  see [`docs/chat-orchestrator.md`](docs/chat-orchestrator.md)); the live
  backend for `chat-ui`/`discord-bot`
  (`docker-compose.yml`'s `N8N_WEBHOOK_URL`/`N8N_CHAT_WEBHOOK_URL` →
  `agent-service:3010/webhook`). Also hosts the Growth engine (see
  [`docs/growth-engine.md`](docs/growth-engine.md)) and its `/growth/*`
  routes backing the Amy Lab dashboard.
- `dspy-optimizer/`, `graphiti-service/`, `scrapling-service/`,
  `openhands-runner/` — the other four pillars of the same rebuild that
  produced `agent-service` (see
  [`docs/unified-architecture-gap-analysis.md`](docs/unified-architecture-gap-analysis.md)):
  an offline classifier-prompt optimizer, the decision/project/growth
  ledger graph (FalkorDB + Ollama), real page fetching/extraction backing
  knowledge-engine's web research, and the OpenHands SDK wrapper
  `coding-orchestrator` can optionally use instead of its own
  hand-rolled agent loop.
- `ios/` — real Xcode-generated SwiftUI app (see
  [`docs/native-ios-app-plan.md`](docs/native-ios-app-plan.md)); chat,
  Home dashboard, and Amy Lab/Growth/Memory are live, voice
  (push-to-talk) is the next milestone.
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
  [`docs/chat-workflow.md`](docs/chat-workflow.md)'s tool-calling gotcha),
  and `benchmark-memory-retrieval.mjs` (same report-writing convention,
  compares `memory-engine`'s self-hosted hybrid search against Honcho's
  hosted dialectic `/chat` endpoint on real stored conversation history —
  requires `HONCHO_API_KEY`).

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
10. Optionally set up `calendar_event` (Google Calendar) and `drive_search`
    (Google Drive) — one Google OAuth consent covers both, as the user
    (not a service account, which only sees resources explicitly shared
    with its own robot email — doesn't scale to "the user's own Drive").
    Create a Google Cloud project, enable the Calendar API and Drive API,
    create an OAuth client (APIs & Services → Credentials → Create
    Credentials → OAuth client ID, type "Desktop app" — no redirect URI
    needs to be pre-registered for that type), then run
    `GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node
    scripts/google-auth.mjs`, open the printed URL, and authorize with the
    Google account to connect. Add the three values it prints
    (`GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`/
    `GOOGLE_REFRESH_TOKEN`) plus `GOOGLE_CALENDAR_ID` (your Gmail address
    for your primary calendar, or the calendar's ID from "Integrate
    calendar") to `.env`. Without this, `calendar_event`/`drive_search`
    return a clear "not configured" error rather than breaking anything.
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
- Automated test suites for most services. `event-bus` (`classify.ts`/
  `goal-matching.ts`/`step-notifications.ts`), `knowledge-engine` (55
  tests over its pure/deterministic pieces), and `agent-service` (86
  tests — originally a parity port of `chat-orchestrator`'s own suite,
  now the only copy since that service was retired and deleted; covers
  `classify`/`safety_net`/`detached_stream`/`system_prompt`) all have
  real coverage now — see each doc under `docs/`. `coding-orchestrator`,
  `sandbox-runner`, `skills-mcp`, `memory-engine`, `chat-ui`, and
  `discord-bot` still have none — every "verified" claim for those is
  manual/live testing against the real stack. Next planned piece of
  work, one service at a time.
- **Coordinator rough edges** (`docs/chat-orchestrator.md`'s own "Known
  rough edges" note describes the same issues as they stood in the
  now-deleted TS version; presumed still present in `agent-service`, the
  live implementation, but not independently re-verified there):
  `dashboard_control`'s 90–107s latency outlier, never root-caused;
  `task_context_manage` being excluded from `toolPolicy: required`'s
  bound-tool counting, which can cause an occasional false-positive
  enforcement retry; Phase 7 (deterministic-only confidence/supersession
  for `memory-engine`) and Phase 8 (sub-workflow decomposition) remain
  tabled pending real evidence of need, not started.
- Formally retiring the n8n `Chat` workflow rollback path and closing
  task #59 (leaked-tool-call recovery) — real traffic runs through
  `agent-service` now, with `chat-orchestrator` (the nearer rollback
  layer this once had) already retired and deleted, 2026-10-13 (see
  `docs/unified-architecture-gap-analysis.md`). The decision to actually
  unpublish `Chat` and remove the `n8n_chat_histories` dual-writes
  hasn't been made yet; see
  [`docs/chat-orchestrator.md`](docs/chat-orchestrator.md)'s "Revisit
  trigger" note.
