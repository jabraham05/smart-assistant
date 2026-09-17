# Discord bridge

Part of the [Smart Assistant](../README.md) project. See
[`docs/chat-workflow.md`](chat-workflow.md) for the `Chat` webhook this
reuses as its backend.

Lets the user talk to Amy from their phone over Discord DM, from anywhere —
not just on the LAN like `chat-ui`. `discord-bot/` (Node/TS, `discord.js`)
is a fourth thin client of the same `Chat` webhook `chat-ui`/`scripts/chat.mjs`
talk to, following the exact NDJSON-streaming parse `chat.mjs` already uses
(only `"item"` events from the `AI Agent` node carry reply text).

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
