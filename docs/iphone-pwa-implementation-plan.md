# Amy iPhone PWA — TASK-001 Audit

Repository and API audit for turning `chat-ui` into an installable, mobile-first
PWA with chat, voice, task/queue, Amy Lab, and memory access. Read-only audit;
no application code changed. Every claim below is grounded in a file this audit
actually read — paths are given so they can be re-verified.

## 1. Current architecture

```
iPhone/Desktop browser
        |
        v
chat-ui (Next.js 16, App Router)  — docker-compose.yml:636-672, port 3000
  src/app/api/*/route.ts  (server-side route handlers, one per backend)
        |
        +--> agent-service  (Python/PydanticAI) :3010  <-- LIVE chat path
        +--> chat-orchestrator (TS, n8n replacement) :3006/3008 <-- rollback-only,
        |      but STILL used for persona/user-profile reads (see gap below)
        +--> event-bus        :3004  (events, goals, home summary/activity, todos)
        +--> knowledge-engine :3005  (entities, projects/Amy-Lab, knowledge search/files)
        +--> graphiti-service :3012  (knowledge graph)
        +--> coding-orchestrator :3003 (coding tasks + logs)
        +--> skills-mcp       :3001  (tool registry, skill proposals)
        +--> Honcho (cloud, api.honcho.dev)  (sessions + message history)

n8n (webhook shim, legacy rollback-of-rollback) :5678
Ollama (inference, shared by every service above) :11434
Postgres, Redis, FalkorDB — internal state, no published ports
Raspberry Pi smart-mirror (separate repo, not in this one) — reuses the
  same Chat webhook with sessionId:"pi-voice", has a working TTS pipeline
  and a staged-but-untested STT/wake-word daemon (see docs/smart-mirror-
  dashboard.md:91-113)
```

**Chat request flow, traced end-to-end:**

1. Browser calls `POST /api/chat` on `chat-ui` — `chat-ui/src/app/api/chat/route.ts:1-20`. Body is `{message, sessionId}` (`chat-ui/src/types/chat.ts:20-23`).
2. The route handler calls `streamFromN8n()` — `chat-ui/src/lib/n8n-client.ts:9-26`, which `fetch()`s `process.env.N8N_WEBHOOK_URL` with `{chatInput, sessionId}` and pipes the raw response body straight through.
3. `N8N_WEBHOOK_URL` is set in `docker-compose.yml:659` to `http://agent-service:3010/webhook` — despite the variable's name, the live backend is **agent-service**, not n8n. This confirms and updates the prior "agent-service is the live chat path" note — it is current and accurate, not stale, and `chat-orchestrator` is explicitly documented in the compose file (`docker-compose.yml:465-478, 503-510`) as the kept-alive instant-rollback path.
4. Response is NDJSON (`Content-Type: application/x-ndjson`), one JSON object per line, shape `N8nStreamEvent` — `chat-ui/src/types/chat.ts:30-46`: `{type: "begin"|"item"|"end"|"error"|"trace"|"ack", content?, trace?, metadata:{nodeId,nodeName,itemIndex,runIndex,timestamp}}`.
5. Client-side, `useChat.ts` (`chat-ui/src/hooks/useChat.ts:16-80+`) reads the stream, feeds each event through a pure reducer (`chat-ui/src/lib/message-reducer.ts`) that assembles `content`, tool-call `steps`, and a readable `trace` (classify / tool_call / tool_result / retry — `chat-ui/src/types/chat.ts:52-71`) into the growing assistant `ChatMessage`.
6. History on session load comes from `GET /api/sessions/[id]/messages` → Honcho (`chat-ui/src/lib/honcho-client.ts`), degrading to `[]` on a Honcho outage rather than failing the page.

**Gap found, not previously recorded:** `GET /api/amy/persona` and `GET /api/amy/user-profile` (`chat-ui/src/app/api/amy/persona/route.ts:1-2`, `.../user-profile/route.ts:1-2`) still call `chat-orchestrator-client.ts`, i.e. they read from the rollback-only `chat-orchestrator` service, not `agent-service`. If `chat-orchestrator` is ever actually turned off, these two reads break even though chat itself is fine. Worth fixing before or during this work, not a mobile-specific concern but touches the same client code.

## 2. Verified API inventory (file-referenced)

All routes below are Next.js Route Handlers under `chat-ui/src/app/api/`, each a thin server-side proxy to one internal service (none of these ports are published to the host except where noted, so `chat-ui` is the only sanctioned entry point):

| Area | Route | Backend | Source |
|---|---|---|---|
| Chat (streaming) | `POST /api/chat` | agent-service via `N8N_WEBHOOK_URL` | `api/chat/route.ts`, `lib/n8n-client.ts` |
| Chat history | `GET /api/sessions`, `GET /api/sessions/[id]/messages` | Honcho cloud | `lib/honcho-client.ts` |
| Persona/profile | `GET /api/amy/persona`, `GET /api/amy/user-profile` | chat-orchestrator (stale dependency, see above) | `lib/chat-orchestrator-client.ts` |
| Events/dashboard | `GET /api/events`, `GET /api/home`, `GET /api/home-activity`, `POST /api/feedback` | event-bus :3004 | `lib/event-bus-client.ts` |
| Goals / todos (queue-adjacent) | `GET/POST /api/goals`, `GET/POST /api/todos` | event-bus :3004 | `lib/event-bus-client.ts` |
| Coding tasks | `GET /api/coding-tasks`, `GET /api/coding-tasks/[id]/log` | coding-orchestrator :3003 | `lib/coding-orchestrator-client.ts` |
| Amy Lab (projects) | `GET /api/projects`, `POST .../approve`, `.../reject`, `.../complete` | knowledge-engine :3005 | `lib/knowledge-engine-client.ts` |
| Skill proposals | `GET /api/skill-proposals`, `POST .../approve`, `.../reject` | skills-mcp :3001 | `lib/skills-registry-client.ts` |
| Memory / knowledge | `GET /api/entities`, `/api/entities/[id]`, `/api/knowledge-search`, `/api/knowledge-files`, `/api/knowledge-files/content` | knowledge-engine :3005 | `lib/knowledge-engine-client.ts` |
| Knowledge graph | `GET /api/knowledge-graph` | graphiti-service :3012 | `lib/graphiti-client.ts` |
| Tool registry | `GET /api/registry` | skills-mcp :3001 | `lib/skills-registry-client.ts` |

**Not found anywhere in the repo** (verified by grep, not assumption):
- Authentication of any kind on any of the above routes — no NextAuth, no session cookie, no API key check in `chat-ui`. The only `Authorization: Bearer` header in the whole frontend is `chat-ui/src/lib/honcho-client.ts:19`, sent outbound to Honcho's cloud API, not something a client supplies inbound.
- Any STT/TTS/speech endpoint, browser or server-side, inside this repo.
- Any Tailscale, reverse-proxy, HTTPS, or VPN configuration anywhere in the repo (checked `.env.example`, `docker-compose.yml`, `scripts/`, `README.md`).
- A web app manifest, service worker, or any PWA-related dependency (`chat-ui/package.json` has none; `chat-ui/public/` has only default Next.js SVGs).

**memory-engine (:3007)** is depended on by `agent-service`/`chat-orchestrator`/`event-bus` in `docker-compose.yml` but has **no `chat-ui` client today** — there is no `/api/memory*` route. If "memory library" in the mobile spec means browsing memory-engine's recall store directly (as opposed to the knowledge-engine "world facts" already exposed via `/api/entities`), that's a new backend route to add, not just a new page.

## 3. Existing functionality to reuse (no duplication needed)

- The entire Next.js App Router shell: `chat-ui/src/app/{chat,amy-lab,artifacts,research,tasks}` and matching hooks (`useChat`, `useEvents`, `useProjects`, `useSessions`, `useRegistry`, `useSkillProposals`, `useHomeSummary`, `useHomeActivity`) already implement everything the mobile milestones ask for in web form: chat+streaming+trace, dashboard/home summary and activity feed, Amy Lab project approve/reject/complete, skill-proposal approve/reject.
- `chat-ui`'s existing NDJSON contract (`N8nStreamEvent`) is exactly what milestone 1/2 need; the Pi's `voice-daemon`/`server/src/integrations/assistant` already proves this same contract works for a second, non-browser client (`docs/smart-mirror-dashboard.md:91-105`) — strong precedent, reuse the pattern, not the Pi's code (it's in a separate, unrelated repo).
- `output: "standalone"` in `next.config.ts` already produces a minimal self-contained server build suited to the existing Docker deployment — no build-system change needed to add a manifest/service worker on top.

## 4. Missing endpoints and components (the real gaps)

1. **No PWA shell**: no manifest, no icons, no service worker, no install prompt handling, no offline/connection-status UI.
2. **No mobile-responsive layout**: `Sidebar.tsx:55` is a fixed `w-60` always-visible column with no collapse/hamburger behavior — unusable on an iPhone portrait screen as-is.
3. **No auth layer at all.** Every route above is open to anything that can reach `chat-ui:3000`. Today that's fine because it's LAN-only; it becomes a real exposure the moment it's reachable from the public internet or even a Tailscale network with other devices on it.
4. **No remote-access story.** Nothing in this repo configures Tailscale, a reverse proxy, or TLS termination. This has to be designed and built, not just verified.
5. **No STT/TTS service reachable by a browser client.** The Pi's voice path works because it's a Node process on the same machine spawning a local binary — that pattern does not translate to a browser/iPhone client, which can only call HTTP(S)/WebSocket endpoints.
6. **No `/api/memory*` route** against memory-engine (:3007) if "memory library" means more than the knowledge-engine entities already exposed.
7. **Persona/profile routes depend on the rollback-only chat-orchestrator** (section 1) — low risk today, but worth reconciling before building more on top of `chat-orchestrator-client.ts`.

## 5. Proposed PWA location

Build directly into the existing `chat-ui` app rather than a new service:
- It already owns the chat UI, the full API-proxy layer, and the Docker build/deploy path (`docker-compose.yml:636-672`, `chat-ui/Dockerfile`).
- A separate PWA app would either re-implement every route in section 2 or call `chat-ui`'s routes remotely, which just adds a hop for no benefit — `chat-ui` is already "the controlled API layer" the original plan calls for.
- Concretely: add `chat-ui/public/manifest.webmanifest` + icons, a service worker (Next 16's built-in support or a minimal hand-written one — confirm current Next 16 PWA story before picking a library, `AGENTS.md` in `chat-ui` warns this Next version has breaking changes from training-data assumptions), make `Sidebar.tsx` responsive (collapse to a bottom tab bar or hamburger under some breakpoint), and add connection-status handling to the existing `fetch` calls.

## 6. Proposed mobile API contract

Reuse, don't replace:
- Keep `POST /api/chat` + NDJSON exactly as-is — it already has everything milestone 1/2 need (streaming content, tool trace, ack events for slow turns).
- Keep every dashboard/queue/Lab/memory route in section 2 as-is for milestone 3/4 — they're already JSON REST, already consumed by React hooks that only need new mobile-friendly views, not new data shapes.
- New additions needed, not adapters over old ones:
  - A session/auth layer in front of all of the above (see section 7) — this is the one genuinely new cross-cutting contract piece.
  - `POST /api/voice/transcribe` (new) if server-side STT is added, or none at all if v1 uses only the browser's on-device speech recognition.
  - `POST /api/voice/speak` or a streamed audio response (new) for TTS, unless v1 uses the browser's `speechSynthesis` API instead (zero new backend).
  - Possibly `/api/memory/*` against memory-engine if the Memory tab needs more than `/api/entities` already provides (confirm against the actual Milestone 4 requirement before building).

## 7. Voice architecture and iPhone-specific limitations

No voice capability exists today that a browser can call — this is new build, not integration. For v1, avoid building a server STT/TTS pipeline at all:
- **STT**: iOS Safari supports `SpeechRecognition` inconsistently across versions and it typically requires continuous network connectivity to Apple's servers; a `MediaRecorder`-captured clip POSTed to a new server-side Whisper endpoint is the robust fallback but is new infrastructure (nothing in this repo today runs Whisper as a service — the Pi's `vendored whisper.cpp` is a separate, untested, separate-repo daemon, not reusable as an HTTP service without being extracted and rebuilt as one).
- **TTS**: iOS Safari's `speechSynthesis` works reliably in a foreground tab and needs zero new backend — strongly prefer this for v1 over building a TTS service, deferring the Pi-style `synthesizeWav` approach unless the browser voices prove unacceptable.
- **Hard iPhone constraints** (from Apple's documented Safari behavior, not from anything in this repo): microphone access requires a secure context (HTTPS, which section 4's gap already requires solving); audio playback typically requires a prior user gesture; background/locked-screen microphone access is not available to a PWA. Ship foreground, tap-to-talk voice first; do not design for always-listening.

## 8. Secure remote-access plan

Nothing in the repo today provides this — proposal, not a verified existing path:
- Put Tailscale (or an equivalent WireGuard-based mesh) on the host machine and on the iPhone; bind `chat-ui`'s published port to the Tailscale interface rather than `0.0.0.0`, or front it with a small reverse proxy (Caddy is the common pairing for automatic HTTPS) that only listens on the Tailscale IP.
- Add a real session-auth layer to `chat-ui` (e.g. a single shared-secret login cookie, since this is a single-user system) before any of this is reachable outside localhost — section 4's point 3 is a precondition, not an afterthought, for exposing this at all.
- Keep every internal-only service exactly as internal as it is today (`skills-mcp`, `event-bus`, `knowledge-engine`, `memory-engine`, `graphiti-service`, `coding-orchestrator`, `sandbox-runner` all have no published ports in `docker-compose.yml` already — preserve that; `chat-ui` remains the only sanctioned entry point).
- Test on home Wi-Fi, cellular, and after a sleep/reconnect cycle, per the original plan — nothing here is automatable from this audit, it needs a physical phone.

## 9. Gaps, risks, dependencies, smallest sequence

**Risks:**
- Shipping remote access before adding auth (section 4.3) would expose every backend route in section 2 — including project/skill-proposal approve/reject actions — to anything on the Tailscale network. Auth must land before or with remote access, not after.
- Next 16's APIs may differ from training-data assumptions per `chat-ui/AGENTS.md` — check `node_modules/next/dist/docs/` for the current PWA/manifest story before picking an implementation approach.
- `chat-orchestrator-client.ts` dependency (section 1) is a small landmine for whoever eventually decommissions `chat-orchestrator`.

**Smallest viable sequence (confirms the original plan's milestones, reordered slightly to put auth before remote-access rather than after):**

1. TASK-002 (next): define/confirm the mobile API contract — in practice this means documenting the existing contract above as "stable" and scoping exactly which new routes (auth, voice) are actually needed, since most of it already exists.
2. TASK-003: PWA shell inside `chat-ui` — manifest, icons, responsive `Sidebar`, connection-status/offline handling.
3. TASK-003b (new, not in the original five): minimal auth layer — this blocks remote access and should land before or alongside the shell work, not after voice.
4. TASK-004: wire chat + streaming into the new shell (mostly already works — confirm on a real iPhone over LAN first, remote second).
5. TASK-005: voice controller — ship browser SpeechRecognition (or tap-to-talk + MediaRecorder) + browser `speechSynthesis` for v1; defer a server STT/TTS service.
6. Dashboard/queue (`/api/events`, `/api/home*`, `/api/goals`, `/api/todos`, `/api/coding-tasks`) and Amy Lab/memory (`/api/projects`, `/api/skill-proposals`, `/api/entities`, `/api/knowledge-*`) wiring — these are view work, not backend work; the APIs already exist.
7. Remote access (Tailscale/Caddy) — only after step 3 (auth) is real.

## 10. Test and deployment plan

- Unit: extend `chat-ui/src/lib/message-reducer.test.ts`'s pattern for any new voice-state-machine logic (keep it pure/testable, same as the existing reducer).
- Integration: a scripted check (similar in spirit to `scripts/chat.mjs`) that hits `/api/chat` over the new auth layer once added, confirming the NDJSON contract still streams correctly through it.
- Manual/device: install via Safari → Share → Add to Home Screen; test chat, dashboard, and voice on home Wi-Fi, cellular, and after phone sleep/reconnect, per the original plan — none of this is verifiable from a repo audit alone.
- Deployment: no change to `docker-compose.yml`'s service topology is required for the shell/auth/voice-v1 work — it's additive to the existing `chat-ui` container. Remote access (section 8) is the one piece that touches infrastructure (Tailscale on the host, optional Caddy container) beyond `chat-ui` itself.

## Recommendation for TASK-002

Most of what TASK-002 would normally produce from scratch already exists and is documented in section 2 — the actual TASK-002 work is narrower than the original plan assumed: (a) write down the contract above as the frozen baseline, (b) scope and spec just the two genuinely new pieces — the auth session contract and the voice transcribe/speak contract (or explicitly defer the latter to browser-only for v1) — and (c) fix the `chat-orchestrator-client.ts` persona/profile dependency while touching that code, since it's a one-line-risk sitting right next to where new mobile auth code will land anyway.
