# Smart-mirror dashboard (Raspberry Pi)

Part of the [Smart Assistant](../README.md) project. See
[`docs/chat-workflow.md`](chat-workflow.md) for the Chat webhook the Pi's
voice path reuses.

A second physical client: a Raspberry Pi with a display, running its own
separate app (`smartmirror-app`, its own git repo on the Pi itself at
`/home/johna/smartmirror-app`, not part of this repo — reached via SSH,
not checked in here). Amy is now that dashboard's actual data source and
controller, not just a chat backend — she decides what widgets show, what
data they display, and can rearrange them on request.

```
dashboard_state (n8n workflow, webhook + Schedule Trigger)
  Webhook: POST /dashboard-state, called by the Pi at server startup
  Schedule Trigger: every 3 hours, pushes to the Pi instead of responding
        |
        v
  Get Persona -> Catalog Ready (Code: GET Pi's /api/widgets/catalog,
        falls back to a hardcoded default catalog if the Pi is briefly
        unreachable) -> Fetch Dashboard Data (skills-mcp
        /internal/dashboard-data, no LLM) -> Decide Widgets (Ollama,
        format-constrained JSON: which catalog types to show, in what
        order, height 1 or 2) -> Parse Decision (deterministic clamp) ->
        Build Row -> Update Dashboard State (Data Table, upsert) ->
        [Webhook path: Respond to Webhook] / [Schedule path: POST
        Pi's /api/assistant/apply]

dashboard_control (n8n workflow, webhook only)
  POST /dashboard-control {action, type?, position?, h?}
        |
        v
  Get Current State (Data Table) -> Apply Change (Code: deterministic,
        no LLM — get_layout/show/hide/move/resize) -> Fetch Fresh Data
        (skills-mcp, for a 'show' bringing back a type with stale data) ->
        Merge Fresh Data -> Save State (Data Table upsert) -> Push To Pi
        (POST /api/assistant/apply, onError continue — a briefly
        unreachable Pi shouldn't fail the tool call) -> Respond to Webhook
```

- **Widgets are a self-describing catalog Amy chooses from, not a
  hardcoded fixed set.** The Pi exposes `GET /api/widgets/catalog`
  (`server/src/core/widgetCatalog.ts`, duplicated from
  `src/widgets/registry.ts`'s `description` field — separate frontend/
  server builds, no shared package) listing the widget types it knows how
  to render and what each is for. `dashboard_state` fetches this and
  decides which types are worth showing right now — a type simply absent
  from the decision doesn't render, no separate visibility flag. The
  `assistant` widget itself is deliberately **not** in the catalog — it's
  always pinned (or, as of the styling cleanup below, removed from the
  layout entirely), not something Amy chooses to show/hide.
- **Layout is a centered row, not a 2D grid — this was a real design
  change mid-build.** The first version used a 4-column grid with `x/y/w/h`
  per widget. The user asked for the widgets centered as a group with
  "enlarge just makes it taller" — which meant dropping 2D positioning
  entirely: widgets are now always the same fixed width, array order is
  left-to-right display order, and only `h` (1 or 2) varies. This
  simplified the schema end-to-end (n8n's decision prompt, the
  `dashboard_control` tool's `move`/`resize` actions, the Pi's CSS) from
  `{type, x, y, w, h}` down to just `{type, h}`. `mirror.css`'s `.modules`
  is `display: flex; flex-wrap: wrap; justify-content: center` instead of
  a CSS grid; each widget's wrapper gets an inline `minHeight` (not a
  fixed `height`, so real content still determines actual size) computed
  from `h`.
- **New skills-mcp routes, no LLM involved**: `GET /internal/dashboard-data`
  (`skills-mcp/src/routes/dashboard-data.ts`) normalizes weather (incl.
  today's high/low)/calendar/Spotify (incl. progress/duration) into the
  Pi's exact existing types, each source fetched/caught independently so
  one failing never blanks the others; `POST /internal/spotify-action`
  (`skills-mcp/src/routes/spotify-action.ts`) does play/pause/next/
  previous for the Pi's transport buttons without a model round-trip. Both
  reuse the same `lib/open-meteo.ts`/`lib/google-calendar.ts`/
  `lib/spotify.ts` the MCP tools already call.
- **New MCP tool `dashboard_control`** (`skills-mcp/src/tools/dashboard-control.ts` +
  `lib/dashboard-control.ts`) — `get_layout`/`show`/`hide`/`move`/`resize`,
  wired into the Chat workflow's classifier (`dashboard` category added to
  `Classify Relevant Tool Groups` + `Expand Groups To Tools`'s `GROUPS`
  map). `move` takes a `position` (index in display order); `resize` takes
  only `h` (1 or 2) — no `x`/`y`/`w` params exist anymore, matching the
  centered-row layout above.
- **The Pi can only reach n8n, never skills-mcp directly** — skills-mcp
  has no published port by design (see
  [`docs/architecture.md`](architecture.md)), and the Pi is a separate
  physical machine on the LAN, not on `assistant-net`. This is why
  `dashboard_state`/`dashboard_control` exist as n8n workflows at all
  rather than the Pi calling skills-mcp's routes directly, and why
  Spotify's play/pause/skip buttons route through a new `spotify_action`
  n8n webhook (`POST /webhook/spotify-action`) forwarding to skills-mcp's
  `/internal/spotify-action`, instead of hitting it directly.
- **Voice**: `POST /api/assistant/voice-command` on the Pi
  (`server/src/integrations/assistant/service.ts`'s `sendVoiceCommandToAmy`)
  reuses the *existing* Chat webhook (same one `chat-ui` talks to, see
  [`docs/chat-workflow.md`](chat-workflow.md)) with a
  fixed `sessionId: "pi-voice"`, rather than a separate assistant pipeline
  — the physical device gets its own continuous multi-turn Honcho/Postgres
  memory, distinct from any browser session. Parses the same NDJSON stream
  `chat-ui`'s `useChat.ts` does (ported to Node), then speaks the reply via
  the already-working TTS path (`synthesizeWav` + `tts:speak` WS event,
  called directly in-process rather than looping back through HTTP to
  `/tts/announce`). **The actual wake-word/STT daemon
  (`voice-daemon/listener.py`, openWakeWord + a vendored whisper.cpp) is
  staged but untested** — no microphone is attached to the Pi yet. Text-in
  → Chat webhook → TTS-out is fully verified end-to-end; only the
  mic-to-text leg is unbuilt hardware-wise.
- **Deliberately not using the Wyoming protocol** (unlike the originally
  considered Home Assistant Voice pattern) — Wyoming's value is
  standardizing a network protocol across *separate* satellite devices,
  which doesn't apply to a single Pi where TTS-out already works via a
  simpler "vendor a binary, spawn it directly from Node" pattern
  (`server/src/integrations/tts/service.ts`). `voice-daemon/listener.py`
  mirrors that same approach for STT instead. Revisit only if multi-room
  satellites are ever wanted.
- **Widget styling cleanup** (user feedback after first seeing it running):
  weather now leads with a large hero temperature + condition + high/low
  (data that was already being fetched but not surfaced); calendar caps at
  2 events with truncated titles on their own line; Spotify became an
  actual mini player (album art thumbnail, progress bar, transport
  controls) instead of plain text; the `assistant` widget was dropped from
  the layout entirely — it only ever showed Amy's internal reasoning text
  ("Weather is relevant because..."), not anything meant for a user to
  read.
- **Latency investigation** (user-reported, both chat/voice response time
  and dashboard updates felt slow):
  - **qwen3:8b defaults to thinking-mode ON even when a call never
    requests it** — confirmed by direct testing: an identical call's
    generation time dropped from ~2.9s to ~0.09s with `think: false` set
    explicitly. Fixed on `Classify Relevant Tool Groups`, the main `AI
    Agent`'s `Ollama Chat Model` node (which had `think: true` set
    *explicitly*, forcing the cost), and `Ollama Direct Fallback`.
  - **The GPU idles down to its lowest power state (P8) between requests**
    on this machine (a consumer GeForce card, not a datacenter GPU) —
    `nvidia-smi --query-gpu=pstate,clocks.sm` showed P8 / 315MHz vs. a
    3090MHz max. The first request after any idle period pays a 3-10s
    "wake up" tax; subsequent requests are fast (~0.3s) until it idles
    down again. `OLLAMA_KEEP_ALIVE=-1` keeps the *model* resident in VRAM
    but doesn't stop the GPU itself from clocking down — a separate
    concern. Fix (user's choice, not yet applied by default): lock a
    higher minimum clock, e.g. `nvidia-smi -lgc 1500,3090` (needs an
    Administrator shell on Windows; doesn't persist across reboots without
    a scheduled task) — trades constant higher power draw/heat for
    eliminating the wake-up delay.
  - **Tried and reverted: parallelizing the Chat workflow's independent
    Honcho/Data Table lookups** (`Ensure Session Exists`/
    `Set User Observe Config`, `Get User Card`, `Get User Card For Amy`,
    `Get Active Skills`/`Format Skills Catalog` — none actually depend on
    each other's output, only on the trigger). Restructured into parallel
    branches synchronized by a chain of `Merge` nodes (`chooseBranch`
    mode), deployed, and measured via actual node start/end timestamps in
    the execution data: **zero overlap, zero speedup**. n8n runs every
    node in a single execution one at a time regardless of branch
    topology in the graph — "parallel" branches don't run concurrently in
    wall-clock time unless you hand-roll real concurrency (e.g. a Code
    node doing `Promise.all()` over raw `fetch()` calls, which runs into
    Honcho's API key living in an n8n credential rather than something a
    Code node can read directly — not pursued given the modest ~500ms
    upside). Reverted the restructuring to avoid the added complexity for
    no benefit.
  - **Real, low-risk win applied**: the Pi's voice-command handler now
    stops reading the Chat webhook's NDJSON stream as soon as the `AI
    Agent` node's own `"end"` event arrives, instead of waiting for the
    whole HTTP connection to close. The workflow keeps running after the
    visible reply (garbage-output check, then the Honcho/Postgres memory
    write) — confirmed via execution timing to add ~900ms that a voice
    reply has no reason to wait on before speaking.
