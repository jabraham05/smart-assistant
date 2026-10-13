# Discord bridge

Part of the [Smart Assistant](../README.md) project. See
[`docs/chat-workflow.md`](chat-workflow.md) for the `Chat` webhook this
originally reused as its backend.

Lets the user talk to Amy from their phone over Discord DM, from anywhere —
not just on the LAN like `chat-ui`. `discord-bot/` (Node/TS, `discord.js`)
is a thin client of the same chat backend `chat-ui`/`scripts/chat.mjs` talk
to, following the exact NDJSON-streaming parse `chat.mjs` already uses
(only `"item"` events whose `metadata.nodeName` is `"AI Agent"` carry reply
text).

**2026-10 update — backend cut over to `agent-service`.** `config.ts`'s
`N8N_CHAT_WEBHOOK_URL` is, despite its name, now pointed at
`http://agent-service:3010/webhook` in `docker-compose.yml` (same Phase 1
infra-rebuild cutover as `chat-ui` — see
[`docs/chat-ui.md`](chat-ui.md)) — `chat-orchestrator`/n8n's `Chat` workflow
are kept running unmodified as a one-line rollback, identical NDJSON
contract either way, so no code here changed for the cutover. `chat-client.ts`'s
`sendChatMessage` also now handles a dedicated `"ack"` event — a
deterministic, server-emitted acknowledgment `agent-service` sends the
moment it decides a turn will be slow (never sent for a fast turn) — relayed
as its own, immediate Discord message via the `onAck` callback, well before
the real reply finishes streaming. And `"error"` events with no real reply
text before them now throw a real error (`` `agent-service turn failed: ...` ``)
instead of silently falling through to `"(no response)"` — previously a
failure outside the per-attempt turn wrapper (classify, system-prompt
assembly, Honcho recall) was indistinguishable from an actually-empty valid
reply.

**Deliberately not the "expose n8n's webhook publicly + n8n's Discord
Trigger node" approach.** That path (Discord's Interactions Endpoint) needs
a real internet-reachable HTTPS URL Discord can POST to, with Ed25519
signature verification — the stack's `WEBHOOK_URL` is `http://localhost:5678/`
by design, and standing up a tunnel/reverse-proxy just for this would be new
attack surface for a project whose default is "zero external exposure"
(Honcho is the one deliberate exception, and even that's an outbound HTTPS
call, never inbound). Discord bots instead connect *outbound* to Discord's
gateway over a websocket (the same way `discord.js` clients normally work),
so `discord-bot` needs no published port and no public URL at all — it's a
`docker-compose` service on `assistant-net` only, reaching `n8n` internally
exactly like `chat-ui` does.

**Scoped to DMs from one allowlisted user, nothing else.** `discord-bot`
ignores every message that isn't a DM, and every DM from a user ID other
than `DISCORD_ALLOWED_USER_ID` — there's no reason for this bot to ever
respond in a server channel or to a stranger who finds it. Session
continuity uses a fixed `discord-<userId>` sessionId (same pattern as the
CLI client's `.chat-session-id` file and the Pi's fixed `"pi-voice"`
session), so Honcho/Postgres memory persists across app restarts and
separate phone sessions.

Setup requires a one-time Discord Developer Portal app + bot (token into
`DISCORD_BOT_TOKEN`, "Message Content Intent" enabled under Privileged
Gateway Intents, invited to any one server the user is also in — Discord
only allows DMing a bot you share a server with, the actual conversation
still happens in the DM afterward) and the user's own Discord user ID
(`DISCORD_ALLOWED_USER_ID`, via Developer Mode > right-click > Copy User
ID) — full steps in `.env.example`.

Typing indicator is kept alive by re-sending `sendTyping()` every 8s while
waiting on a reply (Discord's own indicator only lasts ~10s server-side).
Replies over Discord's 2000-character message cap are split on the nearest
newline/space rather than hard-cut mid-word (`chunkForDiscord` in
`discord-bot/src/chat-client.ts`).

**Also not originally documented here**: every incoming DM publishes a
fire-and-forget `discord`/`dm_received` event to `event-bus`
(`publishDmReceivedEvent` in `index.ts`, `EVENT_BUS_URL` — defaults to
`http://event-bus:3004`) before any reply is generated, same
"never block or delay the real reply on a down/unreachable event-bus"
pattern used elsewhere in this project; and `!new`/`/new` resets a user's
session in memory to a fresh, timestamped `discord-{userId}-{timestamp}` id
(falls back to the original stable session on container restart, since
`sessionOverrides` is an in-memory `Map`, not persisted).

**2026-10-10 — the bot went silently offline for 16+ hours with the
container reporting healthy the whole time, twice, for two different real
reasons.** First: `discord.js` can give up reconnecting after a dropped
gateway session without throwing anything that crashes the process, so
there was nothing for `restart: unless-stopped` to act on — fixed by
explicitly exiting the process (letting Docker's restart policy do the rest)
on `Events.Error`/`Events.ShardError`/`Events.Invalidated`. Second, found
the same day after the first fix: a fully silent gateway drop (no error
event of any kind fired) — the classic shape of a NAT/idle-timeout killing
a long-lived WebSocket with no proper close frame on either side. Fixed
with a watchdog: `Events.Raw` fires for every gateway payload including
heartbeat acks, so tracking time-since-last-activity and self-exiting if it
exceeds `GATEWAY_SILENCE_LIMIT_MS` (120s, well past the ~41s heartbeat
interval) catches this regardless of whether `discord.js`'s own reconnect
logic ever notices.
