# Amy native iOS app — implementation plan

Pivot from the installable PWA (`chat-ui`, still live at `/`, `/home`, `/artifacts`,
`/amy-lab`) to a real SwiftUI app. This doc exists because the actual Swift
work has to happen in a Claude Code session running on a Mac with Xcode —
nothing here can be compiled, run, or screenshotted from the Windows session
that wrote this plan. Hand this file to that session as a starting brief.

**2026-10-12 status update:** the Mac-side session did this. `ios/` is a
real Xcode-generated SwiftUI app (`ios/project.yml` + `xcodegen`, see
`ios/README.md`) already covering Milestones 1, 3, and 4 below (chat, the
Home dashboard, and Amy Lab/Growth/Memory), plus a Swift Testing suite
(`ios/AmyTests/`) for the stream parser/reducer. Milestone 2 (voice)
hasn't started yet — `ios/README.md` lists it as the next milestone,
push-to-talk only, no always-on listening. The "First concrete steps" and
"What this session is explicitly NOT doing" sections below are the
original brief as written before that work happened; left as-is for
history rather than rewritten.

## Why this is a pivot, not a rewrite of everything

The backend doesn't change. Every lesson from the PWA work and the earlier
TASK-001 audit (`docs/iphone-pwa-implementation-plan.md`) still applies:
`chat-ui`'s Next.js API routes are the one sanctioned entry point, internal
services (agent-service, event-bus, knowledge-engine, skills-mcp, etc.) have
no published ports and the native app must not try to reach them directly.
What changes is the client: Swift/SwiftUI talking to that same REST +
NDJSON-streaming API over HTTP, instead of a browser.

**What a native app gets that the PWA structurally can't:**
- Background audio session for voice (the PWA's voice milestone was always
  going to be foreground-only on iOS Safari - a real `AVAudioSession` isn't).
- Real push notifications (APNs) instead of iOS's limited/unreliable Web
  Push support.
- No Safari quirks (this session hit two tonight: `crypto.randomUUID()`
  silently absent off a secure context, and `Secure` cookies silently
  dropped over plain HTTP - a native `URLSession` has neither problem).
- Native animations, haptics, share sheet, keyboard handling.

**What it costs:** a second frontend to build and maintain against the same
backend. The PWA is not being deleted - it stays as a fallback/web client -
but active feature work moves to native per the user's direction.

## Backend changes already made and verified (this session)

Both already merged into branch `amy-pwa-shell` (PR #79), tested against a
real container (not just `next dev`):

1. **Bearer-token auth**, alongside the existing cookie:
   - `POST /api/auth/login` with `{"password": "..."}` returns
     `{"ok": true, "token": "<expiresAt>.<signature>"}` on success, 401 on
     wrong password.
   - Every other route (proxied via `src/proxy.ts`) accepts the same token
     either as the `amy_session` cookie (what the PWA uses) or as
     `Authorization: Bearer <token>` (what the native app should use - no
     cookie jar to manage, no `HTTPCookieStorage` complexity).
   - Verified with `curl`, no cookie jar at all: login → token, bare request
     → 401, request with the bearer token → 200, garbage token → 401.
   - Token format: `"<unixMillis>.<hmacSha256Hex>"`. Treat it as an opaque
     string - don't parse it client-side, just store and resend it.
   - **No logout/revocation endpoint beyond `POST /api/auth/logout`** (which
     just clears the cookie - irrelevant to a bearer client). For native,
     "log out" means the app deletes the token from Keychain. There is no
     server-side session table to revoke against (single shared-secret
     design, see `docs/iphone-pwa-implementation-plan.md` section 8) - if
     that's not acceptable long-term (e.g. wanting remote revoke), that's a
     real backend gap to flag, not something to work around client-side.
   - 30-day expiry (`SESSION_MAX_AGE_SECONDS` in `chat-ui/src/lib/auth.ts`).
     Expect `401` once it lapses; re-prompt for the password, there's no
     refresh-token flow.

2. Nothing else backend-side needs to change for Milestone 1 (chat). The
   dashboard/queue/Lab routes below are unauthenticated-vs-authenticated in
   exactly the same way; bearer auth covers all of them uniformly.

## API contract (verified against source, not assumed)

Base URL: the real docker-compose `chat-ui` at `http://<host-LAN-IP>:3000`
(the app's default; changeable in Settings). The ad-hoc `:3002` test
container used during the PWA work is retired - the app talks to the actual
Amy, nothing else. Every request below needs
`Authorization: Bearer <token>` once logged in, except login itself.

| Area | Route | Notes |
|---|---|---|
| Login | `POST /api/auth/login` | Body `{"password": "..."}`. Returns the bearer token. |
| Chat (streaming) | `POST /api/chat` | Body `{"message": "...", "sessionId": "..."}`. Response is **NDJSON** (`application/x-ndjson`), one JSON object per line - see shape below. Not SSE, not a WebSocket - just a chunked response body you read line-by-line. |
| Chat history | `GET /api/sessions`, `GET /api/sessions/[id]/messages` | Session list (enriched with origin/preview/lastMessageAt) and a given session's message history. |
| Dashboard | `GET /api/home`, `GET /api/home-activity` | Goals/open-tasks/calendar snapshot, and the cross-entity activity feed. |
| Goals / todos | `GET/POST /api/goals`, `GET/POST /api/todos` | |
| Coding tasks | `GET /api/coding-tasks`, `GET /api/coding-tasks/[id]/log` | |
| Amy Lab projects | `GET /api/projects`, `POST /api/projects/[id]/{approve,reject,complete}` | |
| Skill proposals | `GET /api/skill-proposals`, `POST /api/skill-proposals/[id]/{approve,reject}` | |
| Growth engine | `GET /api/growth/{experiments,history,learning-plans,opportunities,proposals,persona-proposal}` + per-item approve/reject/promote/dismiss/defer variants | Added after the original TASK-001 audit; same pattern, see `chat-ui/src/app/api/growth/`. |
| Memory/knowledge | `GET /api/entities`, `/api/entities/[id]`, `/api/knowledge-search`, `/api/knowledge-files`, `/api/knowledge-files/content`, `/api/knowledge-graph` | |
| Tool registry | `GET /api/registry` | |
| Health | `GET /api/health` | Public, no auth needed - use for a connectivity check, same as the PWA's `ConnectionBanner`. |

**Full type definitions to port to Swift `Codable` structs:**
`chat-ui/src/types/chat.ts` (211 lines) - every response shape above is
defined there field-for-field. Don't re-derive these from guessing at the
UI; read that file.

### The chat streaming contract, specifically

`POST /api/chat` → NDJSON body, each line a `N8nStreamEvent`:

```json
{"type": "begin", "metadata": {...}}
{"type": "item", "content": "partial text...", "metadata": {...}}
{"type": "trace", "trace": {"kind": "tool_call", ...}, "metadata": {...}}
{"type": "ack", "content": "...", "metadata": {...}}
{"type": "end", "metadata": {...}}
```

- `type: "ack"` is a deterministic early message for turns classified as
  slow (planning/research/coding) - show it as an interim status, not part
  of the final reply.
- `type: "item"` events accumulate into the assistant's reply content -
  concatenate `content` across consecutive `item` events for one turn.
- `type: "trace"` carries structured info about what the backend actually
  did (classification, tool calls/results, retries) - optional to surface
  in v1, but the shape is in `ChatTraceEvent` if you want a debug view.
- `type: "error"` / `type: "end"` terminate the turn.
- Reference client-side reducer (pure function, good spec to port the
  *logic* of, not the code): `chat-ui/src/lib/message-reducer.ts`.

**Swift side:** `URLSession.bytes(for:)` gives you an `AsyncSequence` of
bytes; wrap it in a line reader (split on `\n`) and `JSONDecoder` each line
into `N8nStreamEvent`. This is a standard pattern - no special library
needed, don't reach for a third-party SSE/NDJSON package for something this
simple.

## Recommended architecture

- **SwiftUI + MVVM**, async/await throughout (no Combine needed given
  `URLSession`'s async APIs cover this). Matches what the PWA's hooks do
  (`useChat`, `useSessions`, etc.) - one `@Observable` view model per
  feature area is a reasonable direct port of that structure.
- **Keychain** for the bearer token (`Security` framework, or a small
  wrapper - don't hand-roll Keychain access code without testing it; it's
  a common source of silent failures). `UserDefaults` is not acceptable for
  a credential, even a low-stakes single-user one.
- **One `APIClient`** owning the base URL + token + the `Authorization`
  header injection, so every feature's network calls go through one place
  - mirrors `chat-ui/src/lib/*-client.ts`'s per-service client pattern, just
    consolidated since there's no server-side service boundary to mirror
    client-side (the whole API is one `chat-ui` origin from the app's POV).
- **No local persistence beyond the token** for v1 - fetch from the API on
  each view, same "thin client" posture the PWA has. Add a cache only if a
  real latency/offline problem shows up, not preemptively.

## Milestones (mirrors the original 4-phase PWA plan, adjusted)

1. **Chat** - the only screen that has to exist for v1 to be useful. Login
   screen (password → Keychain token), conversation list, streaming chat
   view, new-chat. This alone matches what the PWA already does today.
2. **Voice** - the actual payoff for going native. `AVAudioSession` +
   `SFSpeechRecognizer` (or on-device Whisper if local STT quality matters
   more than using Apple's) for input, `AVSpeechSynthesizer` for output.
   Unlike the PWA, background audio session handling is real here - decide
   deliberately how far "background" should go (push-to-talk while
   backgrounded is very different from always-listening, which has real
   battery/privacy implications worth a conscious decision, not a default).
3. **Dashboard/queue** - `/api/home`, `/api/home-activity`, goals/todos,
   coding-task status. Direct port of `HomeDashboard.tsx`'s data needs.
4. **Amy Lab/memory** - growth engine review queue, skill proposals,
   entities/knowledge search. Lowest priority; this is the power-user
   surface the PWA also deferred mobile-responsive work on longest.

## First concrete steps for the Mac-side session

1. Confirm the backend is actually reachable from the Mac: `curl` the
   `/api/health` and `/api/auth/login` endpoints against the real LAN IP
   before writing any Swift, exactly like this session did for the PWA -
   don't assume connectivity, verify it.
2. New Xcode project (File → New → Project, SwiftUI App template) - let
   Xcode generate the project file; don't hand-write `.pbxproj`.
3. `APIClient` + Keychain token storage + login screen first. Get a real,
   verified 200 from `/api/sessions` with a stored bearer token before
   building any UI beyond the login form - same "prove the contract works
   before building on it" sequencing this session used for the PWA's auth.
4. Then the NDJSON streaming parser against `/api/chat`, tested against a
   real conversation turn, before wiring it into a chat view.
5. Chat UI itself last, once both of the above are independently verified.

## What this session is explicitly NOT doing

No Xcode project, no Swift files, no `.pbxproj`. Writing Swift blind, with
no compiler and no simulator, is a worse starting point than an empty
project plus this plan - broken scaffolding is harder to recover from than
no scaffolding. The Mac-side session should start the Xcode project itself.
