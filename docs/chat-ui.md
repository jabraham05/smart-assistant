# `chat-ui` — Next.js chat client

Part of the [Smart Assistant](../README.md) project. Proxies chat through
`chat-orchestrator` (see [`docs/chat-orchestrator.md`](chat-orchestrator.md);
n8n's `Chat` workflow before that) and reads session list/history directly
from Honcho. See [`docs/event-bus-and-goals.md`](event-bus-and-goals.md)
for the event-bus visibility panel added below.

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
