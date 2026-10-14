# `chat-ui` — Next.js chat client

Part of the [Smart Assistant](../README.md) project. Reads session
list/history directly from Honcho. See
[`docs/event-bus-and-goals.md`](event-bus-and-goals.md) for the event-bus
visibility panel added below.

**2026-10 update — the live chat backend is `agent-service`.**
`lib/n8n-client.ts`'s `streamFromN8n()` still POSTs `{chatInput, sessionId}`
to whatever `N8N_WEBHOOK_URL` points at — but as of the infra rebuild's
Phase 1 (PydanticAI agent runtime), `docker-compose.yml` sets that to
`http://agent-service:3010/webhook`, not n8n's own `Chat` workflow. The
NDJSON wire contract is identical across both, so no `chat-ui` code changed
for the cutover, only the URL. `chat-orchestrator`, the TypeScript service
this replaced as the live path, was initially kept running as an
instant-rollback middle layer but has since been retired and deleted (see
[`docs/chat-orchestrator.md`](chat-orchestrator.md)) - the remaining
rollback is `N8N_WEBHOOK_URL` back to n8n's own `Chat` workflow URL.

**2026-10-13 — the stale-dependency gap below is now fixed.** `GET
/api/amy/persona` and `GET /api/amy/user-profile`
(`src/app/api/amy/persona/route.ts`, `.../user-profile/route.ts`) read
from `lib/profile-client.ts` now, which calls `agent-service`'s own
`/persona`/`/user-profile` routes (`profile_routes.py` - see
`docs/agent-service.md`). This had to be fixed before `chat-orchestrator`
could be deleted; left unaddressed, it would have broken Amy Lab's
"Profiles" tab silently while chat itself kept working fine. Originally
found during the iPhone PWA audit (see
`docs/iphone-pwa-implementation-plan.md` §1's "Gap found" note) and left
unresolved at the time.

## 2026-09-21 — session sidebar was silently unusable once real usage accumulated

**The bug**: the sidebar's session list (`SessionList.tsx`/`useSessions.ts`)
called Honcho's `sessions/list` with no filter at all and sorted purely by
`created_at`. Two real, compounding problems, both invisible until enough
real history built up:

1. **No filter** — `sessions/list` returns every session in the workspace,
   including one-way, `amy`-only "sessions" from background notification
   paths (`coding-orchestrator`'s `notifyOrigin`, `event-bus`'s stale-goal
   nudge) — the exact same pollution
   [`docs/skill-gap-scanner.md`](skill-gap-scanner.md) already documented
   and solved for its own transcript-reading branch ("the newest 5 sessions
   were all one-way test/notification sessions with zero real
   back-and-forth").
2. **Sorted by creation time, not last activity** — `discord-bot` gives
   each Discord user one *stable* session (`discord-{userId}`), created
   once and reused forever (see `discord-bot/src/index.ts`). Sorting by
   `created_at` buries that session whenever anything else in the
   workspace was created more recently, however recently the Discord
   session itself was actually used — real, live-verified symptom: the
   real Discord session (created 2026-09-04) sat at the very bottom of the
   list, under dozens of `cli-*` sessions from unrelated `scripts/chat.mjs`
   test runs, with no visual way to tell which entry even *was* the
   Discord conversation (the label was just a bare date/time).

**Fixed** in `lib/honcho-client.ts`'s new `listRealSessions()`:
- Reuses `skill_gap_scanner`'s own already-validated heuristic for
  identifying a genuine conversation — a real turn always inserts a
  `user`+`amy` pair together, so a session's *first* message is `user` iff
  it's real; a one-way notification's only message is `amy`. Implemented
  as one extra `messages/list?reverse=false&size=1` call per session
  (`reverse`/pagination `size` confirmed directly against
  `honcho-src/src/routers/messages.py`'s `get_messages` route, not
  guessed).
- Sorts by each session's actual last message time
  (`messages/list?reverse=true&size=1`), not `created_at`.
- Labels each session's origin (`discord`/`cli`/`chat`, from the session
  id's own prefix convention) and shows a real content preview instead of
  a bare timestamp.

Two extra small Honcho calls per session, run on manual sidebar refresh
only (not a hot path) — acceptable for a personal, single-user dashboard
with a few dozen real sessions.

**Verified live**: the real Discord session correctly sorted to the top
with a real preview ("The event for 'Resident Evil Wednesday' has been
created for 6 PM on Wednesday...") immediately after a real message;
`cli-*` test sessions correctly labeled and sorted by their own real
recency instead of clustering at creation time.

**Not cleaned up, deliberately**: dozens of pre-existing `cli-*` sessions
in the real workspace, most predating this fix by weeks/months (this
project's own documented history of using `scripts/chat.mjs` for real
live verification across many past features — knowledge-engine,
skill-gap-scanner, etc.). Only a handful were confirmed to be disposable
same-session test litter; bulk-deleting by timestamp guesswork risked
destroying real project verification history, so none were removed. The
origin/preview labeling above already solves the actual reported
problem (Discord conversations being impossible to find) without needing
to delete anything.

## 2026-09-21 — added a read-only event-bus visibility panel

No UI had ever existed for `event-bus`'s `events` audit trail — it was
write-only from the outside, visible only via a raw `psql` query. Added:

- `event-bus`: `GET /events?limit=&source=` (see
  [`docs/event-bus-and-goals.md`](event-bus-and-goals.md)'s 2026-09-21
  entry) — a plain, unauthenticated read of the audit trail, newest
  first.
- `chat-ui`: `lib/event-bus-client.ts` + `GET /api/events` (server-side
  proxy, same shape as the existing Honcho proxy routes) +
  `EventLogPanel.tsx`, toggled via a new "event-bus" checkbox next to the
  existing "Debug mode" one in `ChatWindow.tsx`'s header. Shows
  source/type, priority, notify/notified status, origin session, and a
  collapsible raw payload per event.

**Verified live**: toggling the panel surfaced real events from an actual
in-progress Discord conversation (`discord.dm_received` /
`chat.message_received` pairs) with correct payload/session-id detail.

Read-only, no write path added — this is a debugging/observability
surface, not a new event-bus consumer.

## 2026-09-22 — `/research/[id]`: a real page for research write-ups, not raw chat text

**Real gap found via live testing**: asking Amy about completed research
produced either a giant wall of every finding pasted verbatim, or (before
[`docs/chat-orchestrator.md`](chat-orchestrator.md)'s classifier fix) no
real findings at all. New page, `src/app/research/[id]/page.tsx` — a
server component that fetches `GET /research/:id` directly from
knowledge-engine (`src/lib/knowledge-engine-client.ts`, same
internal-only-service pattern as `event-bus-client.ts`/
`skills-registry-client.ts`) and renders the topic, status badge, and
every finding with its confidence and linked citations — the complete,
untruncated version of what a concise chat reply only summarizes.

`research_task_status` (skills-mcp) now attaches a `documentUrl` pointing
here whenever a `sessionId` is present, and only ever hands the model the
first few findings inline (`MAX_FINDINGS_INLINE`, currently 3) rather than
trusting it to summarize on its own — a live re-test proved the model
would pave over an explicit "don't paste every finding" instruction and
do it anyway once all 9 were in its context, so the fix caps what it's
given rather than what it's told. See
[`docs/chat-orchestrator.md`](chat-orchestrator.md)'s Coordinator section
for the classifier-side half of this fix.

**Immediate follow-up, same day**: the `documentUrl` link above still
didn't work in practice — `MessageBubble.tsx` rendered `message.content`
as plain text (React auto-escapes everything), so every `**bold**`,
numbered list, and the markdown link itself all showed up as literal raw
characters. The model was producing correct markdown the whole time;
nothing on the client ever parsed it. New `MarkdownContent.tsx`
(`react-markdown` + `remark-gfm`, new deps) renders it properly, styled to
match each bubble's palette. The bubble itself changed from `<button>` to
a `div role="button"` — a real `<a>` can't validly nest inside a
`<button>` (nested interactive elements), which would have kept the link
visible but unreliable to click; the link's own `onClick` stops
propagation so clicking it doesn't also toggle turn detail underneath it.

## 2026-09-22 — two more real regressions, found via the user reporting "that problem shows up again"

**Session sidebar silently broke again**: a separate branch,
`fix-session-list-max-size` (never merged — found the same way as
`docs/chat-orchestrator.md`'s stranded-fix entry, this time via the user
directly reporting the symptom), had already fixed and *live-deployed* a
real outage: `listSessions()`'s `size=200` query param gets rejected
outright by Honcho with a 422 ("must be ≤ 100"), not clamped — taking
`/api/sessions` from "silently drops new sessions" (the original
2026-09-21 bug above) to "returns nothing at all." This session's own
`chat-ui` rebuilds (for the markdown-rendering fix) rebuilt from the
git-tracked source, which never had the fix, silently re-deploying the
outage over the top of the live patch. Brought the real fix
(`size=100`) into `main` and redeployed; verified live,
`GET /api/sessions` returns real session data again.

**`MessageBubble`'s hydration mismatch**: yet another stranded branch,
`fix-message-bubble-hydration`, independently found the same underlying
constraint this session's markdown-rendering fix already worked around
for a different reason: a `<button>` can only contain phrasing content,
and `StepIndicator` renders a `<ul>`/`<li>` list inside the bubble
whenever a message has tool-call steps — invalid nesting, which made the
browser reparent the DOM and mismatch React's SSR output on essentially
every tool-call turn. The button→div structural fix was already in place
(same fix, arrived at independently for the `<a>`-nesting reason); adopted
the one genuine improvement their version had that this session's didn't
— `preventDefault()` on the Enter/Space handler, so Space doesn't also
scroll the page.

**Broader pattern worth naming**: this is now the third time in one
session that real, live-verified work turned out to be sitting on a
branch that never reached `main` — `97e7a99` (see
[`docs/chat-orchestrator.md`](chat-orchestrator.md)), and these two. A
full remote-branch audit at this point found several more
(`worktree-fix-classifier-bug`, `worktree-self-improvement-cycle`,
`worktree-fix-pr-push-large-diff`) not yet reviewed — real work is
accumulating across concurrent sessions faster than it's landing on
`main`.

## 2026-09-22 — a real home page: goals, open tasks, upcoming events

First piece of the self-improvement direction discussed after the
research-queue build — before Amy can review her own experience, there
needs to be a plain view of current state, and it needs to read from the
same structured storage that later self-improvement/autonomous work will
also read from (not a one-off UI-only fetch). `/` was previously just the
chat window with no landing page; it's now `HomeDashboard.tsx`, three
cards (Goals / Open Tasks / Upcoming Events) fed by one call to
event-bus's new `GET /home-summary` (`docs/event-bus-and-goals.md`'s
2026-09-22 entry) via `lib/event-bus-client.ts`'s `getHomeSummary()` and a
proxying `GET /api/home` route — same server-side-only-fetch pattern as
`event-bus-client.ts`'s existing `listRecentEvents`.

The chat window itself moved to `/chat` (`app/chat/page.tsx`, same
`ChatWindow` component, unchanged apart from `h-screen` → `h-full` so it
sizes correctly under the new shared nav rather than overflowing past it).
A small `Nav.tsx` (Home/Chat links, active-route highlighting via
`usePathname`) now renders in `layout.tsx` above `{children}` on every
page.

While wiring this up, found `docker-compose.yml` had the entire `dashboard`
service block duplicated verbatim (lines 460 and 536) — origin/main had
already fixed this independently; this worktree branch's copy was simply
stale. Removed the duplicate to unblock `docker compose build` rather than
merging the two branches' full divergence.

**Verified live**: `GET /home-summary` returns real data (10 active goals
including the "Build a robotic arm" goal from the research-queue work's
own verification, 6 open task contexts, 6 real upcoming calendar events);
`/` renders all three cards with real content; `/chat` still serves the
full chat experience at 200.

## 2026-09-22 — `/amy`: review and approve Amy's proposed learning projects

Full design/verification in [`docs/knowledge-engine.md`](knowledge-engine.md)'s
own dated entry — this covers only the chat-ui half. New `/amy` page
(`components/amy/ProjectsDashboard.tsx`, same two-Card pattern as
`HomeDashboard.tsx`): a Proposed section (Approve/Reject buttons) and an
Active section (research status, a link to the existing `/research/[id]`
write-up page once available, a "Mark done" button that triggers
consolidation). Backed by three thin API proxy routes under
`app/api/projects/`, matching `app/api/home/route.ts`'s one-liner shape,
and `lib/knowledge-engine-client.ts`'s new `getProjects`/`approveProject`/
`rejectProject`/`completeProject` (same direct-fetch-to-knowledge-engine
pattern as the existing `getResearchDetail`). Added to the shared `Nav.tsx`
alongside Home/Chat.

`/research/[id]/page.tsx` also gained a "Consolidated knowledge" section
(rendered via the existing `MarkdownContent` component) that shows once a
linked project has consolidated that session's findings into a write-up —
otherwise there was nowhere in the UI to actually read one.

## 2026-09-22 — a "Feedback" card on `/amy`

Full design/verification in
[`docs/chat-orchestrator.md`](chat-orchestrator.md)'s dated entry - this
covers only the chat-ui half. `/amy`'s `ProjectsDashboard.tsx` gained a
third, read-only card listing recent `behavior_feedback` events (via
`GET /api/events?type=behavior_feedback`, which needed a `type` param
added alongside the existing `source` one - both here and in
`event-bus`'s own `GET /events`). No actions on this card yet - it exists
purely so captured feedback is actually visible somewhere, not just a row
in Postgres.

## 2026-09-23 — `/amy` gains a Coding Tasks card + activity-aware Proposed/Active cards

Full design/verification in [`docs/knowledge-engine.md`](knowledge-engine.md)'s
dated entry - this covers only the chat-ui half. New
`lib/coding-orchestrator-client.ts` + `GET /api/coding-tasks` (same
direct-fetch-to-internal-service proxy pattern as every other client here)
backs a new read-only "Coding Tasks" card on `ProjectsDashboard.tsx` -
every `coding_tasks` row, whether or not it's linked to a `projects` row,
so a `code_task` fired directly mid-chat shows up here too, not just
project-approved ones.

The `Project` type and the Proposed/Active cards gained `activity_type`
awareness: a small badge per row (research vs coding), and an Active
coding-type row links to its PR (`coding_task_pr_url`, enriched
server-side by knowledge-engine's `listProjects` since `coding_tasks`
lives in a different database with no SQL join available) instead of
`/research/[id]`. The grid moved from 3 to 4 cards (2x2 on desktop).

## 2026-09-23 — console UI rework, shared-secret auth, and `/amy` → `/amy-lab`

**Visual/navigation rework** (`b1850fba`, same day as the Coding Tasks card
above): reworked into a dark, techy console look, and nav restructured into
Home/Chat/Artifacts/Amy Lab, each a real top-level route. The old `/amy`
page and `components/amy/ProjectsDashboard.tsx` described in the entries
above were **renamed and restructured** into `/amy-lab` +
`components/amy-lab/AmyLab.tsx` as part of this — `ProjectsDashboard.tsx`
itself no longer exists; its approve/reject project functionality lives on
inside `AmyLab.tsx`'s "Projects" category instead (see the Memory Library
restructure below). The fixed `Sidebar.tsx` column was replaced by
`AppDrawer.tsx` (collapsible, works on narrow/mobile widths) + `LogoutButton.tsx`.

**Auth, added the same day**: a single shared-secret login
(`AMY_AUTH_PASSWORD`, `src/lib/auth.ts` + `src/proxy.ts`) — every route
except `/login`/`/api/auth/login`/`/api/health`/the PWA install assets now
requires a valid session, checked via an HMAC-signed token carried either as
a cookie (`amy_session`, browser/PWA clients) or a `Bearer` header (native
clients, e.g. the iOS app — see `docs/native-ios-app-plan.md`). Single-user
system, so one password, not a user table. This exists because `chat-ui` was
about to become reachable beyond localhost (Tailscale) with no auth at all
otherwise — see `docs/iphone-pwa-implementation-plan.md` §4.3/§8.

**PWA shell**: `manifest.ts`, `apple-icon.png`, and the other icon assets
were added so the app installs as a home-screen PWA. The broader "turn
chat-ui into a full mobile PWA" plan this came out of
(`docs/iphone-pwa-implementation-plan.md`) was itself superseded shortly
after by a pivot to a real SwiftUI app (`docs/native-ios-app-plan.md`) —
these specific pieces (auth, manifest/icons, `AppDrawer`) shipped and stayed;
the rest of that plan did not continue.

## 2026-10-07/09 — Amy Lab "Memory Library" restructure + Growth dashboard

`AmyLab.tsx` was restructured twice more, both documented in full in
[`docs/growth-engine.md`](growth-engine.md) (not duplicated here since that
doc already covers the chat-ui half in detail): a "Memory Library" pass
(`79fd6432`) regrouping every existing Amy Lab feature plus four new ones
(categorized profile, provenance drill-through, a cross-source Timeline,
real System Prompt sizes) under seven top-level categories — User / Amy /
Growth / Projects / Memories / Knowledge / Session, each with its own
sub-tabs — and a follow-up (`5749be53`) that built out the "Growth"
category into a full five-tab dashboard (Overview/Opportunities/Review
Queue/Learning Plans/History) for the Growth engine's observation →
proposal → consolidation lifecycle. `lib/growth-client.ts` calls
`agent-service`'s `/growth/*` routes directly via a new `AGENT_SERVICE_URL`
env var — `chat-ui`'s first direct line to `agent-service` beyond the chat
webhook itself.
